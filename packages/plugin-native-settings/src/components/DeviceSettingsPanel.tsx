// spec/nativeSettings/index.md, "Story: Adjust the device settings from the local overlay"
import { Button } from "@repo/ui"
import type { DeviceSettingsStatus, SystemVolumeStream } from "@elizaos/os/bridges/definitions/system"
import { settingsLevelAllowed } from "../../gen/nativeSettings.ts"

export interface DeviceSettingsPanelProps {
  readonly settings: DeviceSettingsStatus | undefined
  readonly pending: boolean
  readonly problem?: string
  readonly onBrightness: (level: number) => void
  readonly onVolume: (stream: SystemVolumeStream, level: number) => void
  readonly onOpenSettings: () => void
}

const volumeName = {
  alarm: "Alarm",
  music: "Media",
  notification: "Notifications",
  ring: "Ringtone",
  system: "System",
  voiceCall: "Call",
} satisfies Record<SystemVolumeStream, string>

export function DeviceSettingsPanel({ settings, pending, problem, onBrightness, onVolume, onOpenSettings }: DeviceSettingsPanelProps) {
  return (
    <section aria-label="Device settings" aria-busy={pending} className="grid gap-4">
      {problem && <p role="alert" className="text-destructive">{problem}</p>}
      {settings && <form className="grid gap-2" onSubmit={(event) => {
        event.preventDefault()
        const level = Number(new FormData(event.currentTarget).get("brightness"))
        if (Number.isSafeInteger(level) && settingsLevelAllowed({ canWrite: settings.canWriteSettings, maxLevel: 255 }, level)) onBrightness(level)
      }}>
        <label className="flex items-center gap-3">Brightness
          <input key={settings.brightness} name="brightness" type="range" min={0} max={255}
            defaultValue={Math.round(settings.brightness * 255)} disabled={!settings.canWriteSettings || pending} />
        </label>
        <Button type="submit" disabled={!settings.canWriteSettings || pending}>Apply brightness</Button>
      </form>}
      {settings?.volumes.map((volume) => <form key={volume.stream} className="grid gap-2" onSubmit={(event) => {
        event.preventDefault()
        const level = Number(new FormData(event.currentTarget).get("volume"))
        if (Number.isSafeInteger(level) && settingsLevelAllowed({ canWrite: !pending, maxLevel: volume.max }, level)) onVolume(volume.stream, level)
      }}>
        <label className="flex items-center gap-3">{volumeName[volume.stream]}
          <input key={volume.current} type="range" name="volume" min={0} max={volume.max}
            defaultValue={volume.current} disabled={pending || volume.max <= 0} />
        </label>
        <Button type="submit" variant="outline" disabled={pending || volume.max <= 0}>Apply {volumeName[volume.stream].toLowerCase()} volume</Button>
      </form>)}
      <Button variant="outline" onClick={onOpenSettings}>Open Android settings</Button>
    </section>
  )
}
