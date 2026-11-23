// spec/nativeWifi/index.md, "Story: See whether I joined the network I chose"
import { Button } from "@repo/ui"
import type { WiFiNetwork } from "@elizaos/os/bridges/definitions/wifi"
import type { WifiJoinReport } from "../../gen/nativeWifi.ts"

export interface WifiPanelProps {
  readonly networks: readonly WiFiNetwork[] | undefined
  readonly connected: string | undefined
  readonly joinReport?: WifiJoinReport
  readonly pending: boolean
  readonly problem?: string
  readonly onScan: () => void
  readonly onJoin: (network: WiFiNetwork) => void
  readonly onOpenInternetPanel: () => void
}

const joinText = {
  WifiApprovalPending: "Approve this network in Android.",
  WifiJoined: "Connected.",
  WifiNeedsPortal: "This network needs you to sign in.",
  WifiJoinUnverified: "Connection could not be confirmed.",
  WifiNotJoined: "Connection was not made.",
} satisfies Record<WifiJoinReport, string>

export function WifiPanel({ networks, connected, joinReport, pending, problem, onScan, onJoin, onOpenInternetPanel }: WifiPanelProps) {
  return (
    <section aria-label="Wi-Fi" aria-busy={pending} className="grid gap-4">
      <div className="flex flex-wrap gap-3">
        <Button onClick={onScan} disabled={pending}>Scan networks</Button>
        <Button variant="outline" onClick={onOpenInternetPanel}>Open Internet settings</Button>
      </div>
      {joinReport && <p role="status">{joinText[joinReport]}</p>}
      {problem && <p role="alert" className="text-destructive">{problem}</p>}
      {networks?.length === 0 && <p>No nearby networks found.</p>}
      {networks && <ul className="grid gap-2">
        {networks.map((network) => <li key={network.ssid} className="flex items-center justify-between gap-3 border-b border-border pb-2">
          <span>{network.ssid}</span>
          {connected === network.ssid
            ? <span className="text-muted-foreground">Connected</span>
            : <Button variant="outline" disabled={pending} onClick={() => {
              if (network.security === "eap" || network.security === "wep") onOpenInternetPanel()
              else onJoin(network)
            }}>Join<span className="sr-only"> {network.ssid}</span></Button>}
        </li>)}
      </ul>}
    </section>
  )
}
