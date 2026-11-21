// spec/os/voice/cloudSpeech.md, "Story: Talk to the agent through the cloud speech relay"; spec/os/voice/cloudSpeech.md, "Story: Transcribe a recording or hear a reply with one cloud request"
package ai.eliza.voice;

import ai.eliza.plugins.signin.CredentialJson;
import ai.eliza.voice.CloudSpeechPolicy.Answer;
import ai.eliza.voice.CloudSpeechPolicy.Direction;
import ai.eliza.voice.CloudSpeechPolicy.Event;
import ai.eliza.voice.CloudSpeechPolicy.Frame;
import ai.eliza.voice.CloudSpeechPolicy.Notice;
import ai.eliza.voice.CloudSpeechPolicy.OutputNotice;
import ai.eliza.voice.CloudSpeechPolicy.Refusal;
import ai.eliza.voice.CloudSpeechPolicy.RefusalCode;
import ai.eliza.voice.CloudSpeechPolicy.RefusalReason;
import ai.eliza.voice.CloudSpeechPolicy.RelayErrorCode;
import ai.eliza.voice.CloudSpeechPolicy.SlotAnswer;
import ai.eliza.voice.CloudSpeechPolicy.SttKind;
import ai.eliza.voice.CloudSpeechPolicy.Wait;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class CloudSpeechReplay {
  private CloudSpeechPolicy.Machine machine = new CloudSpeechPolicy.Machine();

  private static Map<String, Object> object(Map<String, Object> e, String key) { return CredentialJson.object(e.get(key), key); }

  private static <T extends Enum<T>> T tagged(Class<T> type, String tag) {
    for (T value : type.getEnumConstants()) {
      StringBuilder camel = new StringBuilder();
      for (String part : value.name().split("_")) camel.append(part.charAt(0)).append(part.substring(1).toLowerCase(Locale.ROOT));
      if (camel.toString().equals(tag)) return value;
    }
    throw new IllegalArgumentException(type.getSimpleName() + " " + tag);
  }

  private static Wait waitTime(Map<String, Object> w) {
    return switch (CredentialJson.text(w, "tag")) {
      case "NoWait" -> CloudSpeechPolicy.NO_WAIT;
      case "RetryAt" -> new Wait.RetryAt(CredentialJson.whole(w, "retryAtMs"));
      case "ResetsAt" -> new Wait.ResetsAt(CredentialJson.whole(w, "resetsAtMs"));
      default -> throw new IllegalArgumentException("wait");
    };
  }

  private static Answer answer(Map<String, Object> a) {
    return switch (CredentialJson.text(a, "tag")) {
      case "Answered" -> CloudSpeechPolicy.ANSWERED;
      case "Misdirected" -> CloudSpeechPolicy.MISDIRECTED;
      case "Unreachable" -> CloudSpeechPolicy.UNREACHABLE;
      case "Refused" -> {
        Map<String, Object> r = object(a, "refusal");
        yield new Answer.Refused(new Refusal(tagged(RefusalCode.class, CredentialJson.text(r, "code")),
          tagged(RefusalReason.class, CredentialJson.text(r, "reason")), waitTime(object(r, "wait"))));
      }
      default -> throw new IllegalArgumentException("answer");
    };
  }

  private static SttKind stt(String kind) {
    return kind.equals("SttConnected") ? SttKind.CONNECTED : tagged(SttKind.class, kind);
  }

  private static RelayErrorCode relayCode(String code) {
    if (!code.startsWith("Relay")) throw new IllegalArgumentException("relay code " + code);
    return tagged(RelayErrorCode.class, code.substring("Relay".length()));
  }

  private static Frame frame(Map<String, Object> f) {
    return switch (CredentialJson.text(f, "tag")) {
      case "ReadyFrame" -> new Frame.Ready();
      case "ExtendedFrame" -> new Frame.Extended();
      case "SttFrame" -> new Frame.Stt(stt(CredentialJson.text(f, "kind")));
      case "PreparedFrame" -> new Frame.Prepared(CredentialJson.text(f, "id"));
      case "AudioFrame" -> new Frame.Audio(CredentialJson.text(f, "id"));
      case "FlushedFrame" -> new Frame.Flushed(CredentialJson.text(f, "id"));
      case "CompleteFrame" -> new Frame.Complete(CredentialJson.text(f, "id"));
      case "ErrorFrame" -> new Frame.Error(relayCode(CredentialJson.text(f, "code")),
        !"NoRelayReason".equals(CredentialJson.text(object(f, "reason"), "tag")));
      case "CloseFrame" -> new Frame.Close(CredentialJson.small(f, "closeCode"));
      default -> throw new IllegalArgumentException("frame");
    };
  }

  private static OutputNotice output(Map<String, Object> n) {
    String tag = CredentialJson.text(n, "tag");
    if (tag.equals("FirstAudio")) CredentialJson.whole(n, "utteranceId");
    return tagged(OutputNotice.class, tag);
  }

  private static Event event(Map<String, Object> e) {
    return switch (CredentialJson.text(e, "type")) {
      case "consentClock" -> new Event.ConsentClock(CredentialJson.whole(e, "waitMs"));
      case "consentGiven" -> new Event.ConsentGiven();
      case "quietStep" -> new Event.QuietStep();
      case "begin" -> new Event.Begin();
      case "consentDismissed" -> new Event.ConsentDismissed();
      case "credentialChanged" -> new Event.CredentialChanged(CredentialJson.small(e, "version"));
      case "minted" -> new Event.Minted(answer(object(e, "answer")));
      case "protocolEnd" -> new Event.ProtocolEnd();
      case "relayLost" -> new Event.RelayLost();
      case "frameArrived" -> new Event.FrameArrived(frame(object(e, "frame")));
      case "unmute" -> new Event.Unmute(CredentialJson.flag(e, "recordAudio"));
      case "mute" -> new Event.Mute();
      case "captureAnswered" -> new Event.CaptureAnswered(tagged(SlotAnswer.class, CredentialJson.text(e, "slot")));
      case "speak" -> new Event.Speak(CredentialJson.text(e, "utteranceId"), CredentialJson.small(e, "pace"));
      case "audioArrived" -> new Event.AudioArrived(CredentialJson.text(e, "utteranceId"), CredentialJson.whole(e, "audioMs"));
      case "cancelReply" -> new Event.CancelReply();
      case "played" -> new Event.Played(CredentialJson.whole(e, "playedMs"));
      case "outputNotice" -> new Event.Output(output(object(e, "notice")));
      case "stop" -> new Event.Stop();
      case "batchRequested" -> new Event.BatchRequested(CredentialJson.small(e, "requestId"), tagged(Direction.class, CredentialJson.text(e, "direction")));
      case "batchCancelled" -> new Event.BatchCancelled(CredentialJson.small(e, "requestId"));
      case "batchAnswered" -> new Event.BatchAnswered(CredentialJson.small(e, "requestId"), answer(object(e, "answer")));
      default -> throw new IllegalArgumentException("event " + e.get("type"));
    };
  }

  private String state(List<Notice> out) {
    StringBuilder notices = new StringBuilder("[");
    for (Notice notice : out) {
      if (notices.length() > 1) notices.append(',');
      notices.append(CloudSpeechPolicy.json(notice));
    }
    return "{\"state\":" + CloudSpeechPolicy.json(machine.state()) + ",\"out\":" + notices.append(']');
  }

  private String answer(String line) {
    Map<String, Object> request = CredentialJson.object(CredentialJson.parse(line), "request");
    if (!request.containsKey("event")) {
      machine = new CloudSpeechPolicy.Machine();
      return state(List.of()) + "}";
    }
    CloudSpeechPolicy.Step step = machine.apply(event(CredentialJson.object(request.get("event"), "event")));
    return state(step == null ? List.of() : step.out()) + ",\"outcome\":\"" + (step == null ? "refused" : "accepted") + "\"}";
  }

  public static void main(String[] args) throws Exception {
    CloudSpeechReplay replay = new CloudSpeechReplay();
    PrintStream printer = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line = in.readLine(); line != null; line = in.readLine()) {
      try {
        printer.println(replay.answer(line));
      } catch (RuntimeException broken) {
        printer.println("{\"error\":" + CredentialJson.quote(String.valueOf(broken.getMessage())) + "}");
      }
    }
  }
}
