// spec/client.md, "A tab can go offline and back online, and queue edits while offline"; spec/client.md, "A client can catch up after editing, and can be told of a refusal"
import { type Client, canGoOffline, canGoOnline } from "../../../gen/client.ts";
import { cn, focusRing } from "../lib/cn.ts";

export interface SyncStatusProps {
  client: Client;
  /** The user takes the tab online or offline. */
  onOnline: (online: boolean) => void;
}

/**
 * The tab's connection, a dot that is filled while online and switches it, beside the number of edits the server refused.
 * @model spec/client.md
 */
export function SyncStatus({ client, onOnline }: SyncStatusProps) {
  const { online, refusals } = client;
  return (
    <div className="flex items-center gap-2">
      {refusals > 0 && (
        <span role="status" aria-label={`${refusals} edits refused`} className="font-semibold text-warn">
          ⚠ {refusals}
        </span>
      )}
      <button type="button" aria-label="Online" aria-pressed={online} disabled={!(online ? canGoOffline(client) : canGoOnline(client))} onClick={() => onOnline(!online)} className={cn(focusRing, "grid size-9 place-items-center rounded-md")}>
        <span className={cn("size-4 rounded-full border-2 border-ok", online && "bg-ok")} />
      </button>
    </div>
  );
}
