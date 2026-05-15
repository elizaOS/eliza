import { useEffect, useRef, useState } from "react";
import { AvatarHost } from "../../../avatar-runtime";

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export interface StateMicProps {
  transcript?: string;
  onContinue: () => void;
  onSkip: () => void;
  onRequestPermission?: () => Promise<boolean> | boolean;
}

function isMediaDevicesAvailable(): boolean {
  if (typeof navigator === "undefined") return false;
  const md = (navigator as Navigator & { mediaDevices?: MediaDevices })
    .mediaDevices;
  return Boolean(md?.enumerateDevices);
}

export function StateMic(props: StateMicProps): JSX.Element {
  const { transcript, onContinue, onSkip, onRequestPermission } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [permissionGranted, setPermissionGranted] = useState(false);

  useEffect(() => {
    if (!isMediaDevicesAvailable()) return;
    if (!permissionGranted) return;
    const md = navigator.mediaDevices;
    md.enumerateDevices().then((list) => {
      const audioInputs = list
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label || "Microphone",
        }));
      setDevices(audioInputs);
    });
  }, [permissionGranted]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let phase = 0;
    const draw = (): void => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      const mid = h / 2;
      const amp = permissionGranted ? 26 : 12;
      for (let i = 0; i <= 64; i += 1) {
        const t = i / 64;
        const x = t * w;
        const y =
          mid +
          Math.sin(t * Math.PI * 6 + phase) * amp +
          Math.sin(t * Math.PI * 12 + phase * 1.6) * amp * 0.3;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      phase += 0.08;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [permissionGranted]);

  const requestPermission = async (): Promise<void> => {
    if (onRequestPermission) {
      const ok = await onRequestPermission();
      setPermissionGranted(Boolean(ok));
      return;
    }
    setPermissionGranted(true);
  };

  return (
    <section className="eliza-ob-screen" data-eliza-ob-state="mic">
      <div className="eliza-ob-agent">
        <div
          className="eliza-ob-agent-canvas"
          style={{ width: "min(270px, 78vw)", height: 112 }}
        >
          <AvatarHost />
        </div>
        <div className="eliza-ob-transcript">
          {transcript ??
            "You can talk to me if you'd like. But no worries if you're shy. I get it."}
        </div>
      </div>
      <div style={{ display: "grid", gap: 12, marginTop: 28 }}>
        <div className="eliza-ob-mic-wave-wrap">
          <canvas
            ref={canvasRef}
            className="eliza-ob-mic-wave-canvas"
            width={640}
            height={170}
          />
        </div>
      </div>
      <div className="eliza-ob-mic-controls">
        <select
          className="eliza-ob-select"
          aria-label="Audio input"
          value={selectedDeviceId}
          onChange={(event) => setSelectedDeviceId(event.target.value)}
        >
          <option value="">Default microphone</option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
        <div className="eliza-ob-audio-actions">
          <button
            type="button"
            className="eliza-ob-icon-btn"
            aria-label="Microphone"
            onClick={requestPermission}
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
              <path d="M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <path d="M12 18v3" />
              <path d="M9 21h6" />
            </svg>
          </button>
          <button
            type="button"
            className="eliza-ob-btn orange"
            onClick={onContinue}
          >
            Continue
          </button>
        </div>
        <div className="eliza-ob-skip-row">
          <button type="button" className="eliza-ob-skip-link" onClick={onSkip}>
            skip voice input
          </button>
        </div>
      </div>
    </section>
  );
}
