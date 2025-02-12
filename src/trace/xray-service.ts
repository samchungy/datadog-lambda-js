import { randomBytes } from "crypto";
import { logDebug } from "../utils";
import { SampleMode, TraceContext, TraceSource } from "./trace-context-service";
import BigNumber from "bignumber.js";
import { Socket, createSocket } from "dgram";
import { SpanContextWrapper } from "./span-context-wrapper";
import { StepFunctionContext } from "./step-function-service";

const AMZN_TRACE_ID_ENV_VAR = "_X_AMZN_TRACE_ID";
const AWS_XRAY_DAEMON_ADDRESS_ENV_VAR = "AWS_XRAY_DAEMON_ADDRESS";

interface XrayTraceHeader {
  traceId: string;
  parentId: string;
  sampled: string;
}

export class XrayService {
  private readonly subsegmentName = "datadog-metadata";
  private readonly subsegmentNamespace = "datadog";
  private readonly baggageSubsegmentKey = "root_span_metadata";
  private readonly subsegmentKey = "trace";
  private readonly lambdaFunctionTagsKey = "lambda_function_tags";

  public addLambdaTriggerTags(triggerTags: { [key: string]: string }) {
    this.add(this.lambdaFunctionTagsKey, triggerTags);
  }

  public addStepFunctionContext(context: StepFunctionContext) {
    this.add(this.baggageSubsegmentKey, context);
  }

  public addMetadata(metadata: Record<string, any>) {
    this.add(this.subsegmentKey, metadata);
  }

  private add(key: string, metadata: Record<string, any>) {
    const subsegment = this.generateSubsegment(key, metadata);

    if (subsegment === undefined) return;

    this.sendSubsegment(subsegment);
  }

  private generateSubsegment(key: string, metadata: Record<string, any>) {
    const context = this.parseTraceContextHeader();
    if (context === undefined) return;

    const sampled = this.convertToSampleMode(parseInt(context.sampled, 10));
    if (sampled === SampleMode.USER_REJECT || sampled === SampleMode.AUTO_REJECT) {
      logDebug("Discarding Xray metadata subsegment due to sampling");
      return;
    }

    const milliseconds = Date.now() * 0.001;

    return JSON.stringify({
      id: randomBytes(8).toString("hex"),
      trace_id: context.traceId,
      parent_id: context.parentId,
      name: this.subsegmentName,
      start_time: milliseconds,
      end_time: milliseconds,
      type: "subsegment",
      metadata: {
        [this.subsegmentNamespace]: {
          [key]: metadata,
        },
      },
    });
  }

  private parseTraceContextHeader(): XrayTraceHeader | undefined {
    const header = process.env[AMZN_TRACE_ID_ENV_VAR];
    if (header === undefined) {
      logDebug("Couldn't read Xray trace header from env");
      return;
    }

    // Example: Root=1-5e272390-8c398be037738dc042009320;Parent=94ae789b969f1cc5;Sampled=1
    logDebug(`Reading Xray trace context from env var ${header}`);
    const [root, parent, _sampled] = header.split(";");
    if (parent === undefined || _sampled === undefined) return;

    const [, traceId] = root.split("=");
    const [, parentId] = parent.split("=");
    const [, sampled] = _sampled.split("=");
    if (traceId === undefined || parentId === undefined || sampled === undefined) return;

    return {
      traceId,
      parentId,
      sampled,
    };
  }

  private convertToSampleMode(xraySampled: number): SampleMode {
    return xraySampled === 1 ? SampleMode.USER_KEEP : SampleMode.USER_REJECT;
  }

  private sendSubsegment(segment: string) {
    const daemon = process.env[AWS_XRAY_DAEMON_ADDRESS_ENV_VAR];
    if (daemon === undefined) {
      logDebug("Xray daemon env var not set, not sending subsegment");
      return;
    }

    const parts = daemon.split(":");
    if (parts.length <= 1) {
      logDebug("X-Ray daemon env var has invalid format, not sending sub-segment");
      return;
    }

    const port = parseInt(parts[1], 10);
    const address = parts[0];
    const message = Buffer.from(`{\"format\": \"json\", \"version\": 1}\n${segment}`);
    let client: Socket | undefined;
    try {
      client = createSocket("udp4");
      // Send segment asynchronously to xray daemon
      client.send(message, 0, message.length, port, address, (error, bytes) => {
        client?.close();
        logDebug(`Xray daemon received metadata payload`, { error, bytes });
      });
    } catch (error) {
      if (error instanceof Error) {
        client?.close();
        logDebug("Error occurred submitting to Xray daemon", error);
      }
    }
  }

  public extract(): SpanContextWrapper | null {
    const traceContext = this.traceContext;
    if (traceContext === undefined) return null;

    const spanContext = SpanContextWrapper.fromTraceContext(traceContext);
    if (spanContext === null) return null;
    logDebug(`Extracted trace context from xray context`, { traceContext });

    return spanContext;
  }

  private get traceContext(): TraceContext | undefined {
    const context = this.parseTraceContextHeader();
    if (context === undefined) {
      logDebug("Couldn't parse Xray trace header from env");
      return;
    }

    const parentId = this.convertToParentId(context.parentId);
    if (parentId === undefined) {
      logDebug("Couldn't parse Xray Parent Id", context);
      return;
    }
    const traceId = this.convertToTraceId(context.traceId);
    if (traceId === undefined) {
      logDebug("Couldn't parse Xray Trace Id", context);
      return;
    }
    const sampleMode = this.convertToSampleMode(parseInt(context.sampled, 10));

    const trace = {
      traceId,
      parentId,
      sampleMode,
      source: TraceSource.Xray,
    };

    return trace;
  }

  private convertToParentId(xrayParentId: string): string | undefined {
    if (xrayParentId.length !== 16) return;

    const hex = new BigNumber(xrayParentId, 16);
    if (hex.isNaN()) return;

    return hex.toString(10);
  }

  private convertToTraceId(xrayTraceId: string): string | undefined {
    const parts = xrayTraceId.split("-");
    if (parts.length < 3) return;

    const lastPart = parts[2];
    if (lastPart.length !== 24) return;

    // We want to turn the last 63 bits into a decimal number in a string representation
    // Unfortunately, all numbers in javascript are represented by float64 bit numbers, which
    // means we can't parse 64 bit integers accurately.
    const hex = new BigNumber(lastPart, 16);
    if (hex.isNaN()) return;

    // Toggle off the 64th bit
    const last63Bits = hex.mod(new BigNumber("8000000000000000", 16));
    return last63Bits.toString(10);
  }
}
