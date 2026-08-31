/**
 * Responsive owner workspace for agreements, linked calendars, school-source
 * workflow review, and monthly family packets. Every mutation delegates to an
 * injected adapter and renders failures explicitly; no optimistic success is
 * fabricated for unavailable backend contracts.
 */

import { Button, Input } from "@elizaos/ui";
import {
  CalendarSync,
  Check,
  FileCheck2,
  GraduationCap,
  RefreshCw,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  agreementUploadSizeMessage,
  MAX_AGREEMENT_PDF_BYTES,
} from "../../lifeops/household/agreement-upload-limits.js";
import { defaultFamilyOperationsAdapter } from "./adapter.js";
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
} from "./types.js";

type Tab = "agreements" | "calendar" | "school" | "packets";

const tabs: Array<{ id: Tab; label: string; icon: typeof FileCheck2 }> = [
  { id: "agreements", label: "Agreement", icon: FileCheck2 },
  { id: "calendar", label: "Calendar sync", icon: CalendarSync },
  { id: "school", label: "School calendar", icon: GraduationCap },
  { id: "packets", label: "Monthly packet", icon: UsersRound },
];

function date(value: string | null | undefined): string {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}

function Card({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: 20,
        background: "var(--card)",
        padding: "clamp(16px, 3vw, 24px)",
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2>
      {detail ? (
        <p
          style={{
            margin: "6px 0 18px",
            color: "var(--muted)",
            lineHeight: 1.5,
          }}
        >
          {detail}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <div
      role="alert"
      style={{
        border: "1px solid var(--status-danger)",
        borderRadius: 12,
        padding: 14,
      }}
    >
      <strong>Unavailable</strong>
      <p style={{ margin: "5px 0 0", color: "var(--muted)" }}>{message}</p>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p style={{ color: "var(--muted)", margin: 0 }}>{children}</p>;
}

function AgreementUploadCard({
  adapter,
  refresh,
}: {
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
}) {
  const [agreementKey, setAgreementKey] = useState("parenting-plan");
  const [title, setTitle] = useState("Parenting agreement");
  const [pageCount, setPageCount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const validPageCount = Number(pageCount);
  const canUpload =
    file?.type === "application/pdf" &&
    file.size > 0 &&
    file.size <= MAX_AGREEMENT_PDF_BYTES &&
    title.trim().length > 0 &&
    agreementKey.trim().length > 0 &&
    Number.isSafeInteger(validPageCount) &&
    validPageCount > 0;

  const upload = async () => {
    if (!file || !canUpload) return;
    setError(null);
    setNotice(null);
    try {
      await adapter.uploadAgreement({
        agreementKey: agreementKey.trim(),
        title: title.trim(),
        pageCount: validPageCount,
        file,
      });
      setNotice("Immutable agreement version uploaded.");
      setFile(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed");
    }
  };

  return (
    <Card
      title="Upload signed agreement"
      detail="Signed PDFs stay immutable and owner-private. Confirm the page count for citation review."
    >
      <Button variant="outline" onClick={() => setExpanded((value) => !value)}>
        {expanded ? "Close PDF form" : "Choose a signed PDF"}
      </Button>
      {expanded ? (
        <div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: 12,
              marginTop: 14,
            }}
          >
            <label
              htmlFor="agreement-title"
              style={{ display: "grid", gap: 6 }}
            >
              <span>Agreement name</span>
              <Input
                id="agreement-title"
                value={title}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setTitle(event.target.value)
                }
              />
            </label>
            <label htmlFor="agreement-key" style={{ display: "grid", gap: 6 }}>
              <span>Agreement key</span>
              <Input
                id="agreement-key"
                value={agreementKey}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setAgreementKey(event.target.value)
                }
              />
            </label>
            <label
              htmlFor="agreement-pages"
              style={{ display: "grid", gap: 6 }}
            >
              <span>PDF page count</span>
              <Input
                id="agreement-pages"
                type="number"
                min={1}
                step={1}
                value={pageCount}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setPageCount(event.target.value)
                }
              />
            </label>
            <label htmlFor="agreement-pdf" style={{ display: "grid", gap: 6 }}>
              <span>Signed PDF</span>
              <Input
                id="agreement-pdf"
                type="file"
                aria-label="Signed PDF"
                accept="application/pdf,.pdf"
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const selected = event.target.files?.[0] ?? null;
                  setFile(selected);
                  setNotice(null);
                  setError(
                    selected && selected.size > MAX_AGREEMENT_PDF_BYTES
                      ? agreementUploadSizeMessage()
                      : selected && selected.size < 1
                        ? "Agreement PDF must not be empty."
                        : null,
                  );
                }}
              />
              <small style={{ color: "var(--muted)" }}>
                Maximum size: 20 MiB
              </small>
            </label>
          </div>
          <div style={{ marginTop: 14 }}>
            <Button disabled={!canUpload} onClick={() => void upload()}>
              Upload immutable PDF
            </Button>
          </div>
          {notice ? <p role="status">{notice}</p> : null}
          {error ? <Unavailable message={error} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

function AgreementPanel({
  state,
  adapter,
  refresh,
}: {
  state: FamilyOperationsSnapshot["agreements"];
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [reason, setReason] = useState("");
  const [targetType, setTargetType] = useState<"agent" | "chat">("agent");
  const [targetId, setTargetId] = useState("");
  const [principalEntityId, setPrincipalEntityId] = useState("");
  const [householdGrantId, setHouseholdGrantId] = useState("");
  const [revokeGrantId, setRevokeGrantId] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [preview, setPreview] = useState<Awaited<
    ReturnType<FamilyOperationsAdapter["previewGrant"]>
  > | null>(null);
  const [pins, setPins] = useState<
    Awaited<ReturnType<FamilyOperationsAdapter["listPins"]>>
  >([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agreements = state.status === "ready" ? state.data : [];
  const selected =
    agreements.find((item) => item.artifact.id === selectedId) ?? agreements[0];
  const selectedArtifactId = selected?.artifact.id;

  useEffect(() => {
    if (!selectedArtifactId) return;
    setSelectedId(selectedArtifactId);
    adapter
      .listPins(selectedArtifactId)
      .then(setPins)
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Pins could not load",
        ),
      );
  }, [adapter, selectedArtifactId]);

  const act = async (operation: () => Promise<unknown>, success: string) => {
    setError(null);
    setNotice(null);
    try {
      await operation();
      setNotice(success);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed");
    }
  };

  if (state.status === "unavailable")
    return <Unavailable message={state.message} />;
  if (!selected)
    return (
      <div style={{ display: "grid", gap: 16 }}>
        <AgreementUploadCard adapter={adapter} refresh={refresh} />
        <Empty>No parenting agreement has been uploaded yet.</Empty>
      </div>
    );
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <AgreementUploadCard adapter={adapter} refresh={refresh} />
      <Card
        title="Agreement versions"
        detail="Signed PDFs are immutable. Select a version to review its page-cited obligations."
      >
        <label style={{ display: "grid", gap: 7, maxWidth: 520 }}>
          <span>Version</span>
          <select
            aria-label="Agreement version"
            value={selected.artifact.id}
            onChange={(event) => setSelectedId(event.target.value)}
            style={{
              minHeight: 44,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--txt)",
              padding: "0 12px",
            }}
          >
            {agreements.map((view) => (
              <option key={view.artifact.id} value={view.artifact.id}>
                {view.artifact.title} · v{view.artifact.version}
              </option>
            ))}
          </select>
        </label>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
            margin: "16px 0 0",
          }}
        >
          <div>
            <dt style={{ color: "var(--muted)" }}>Pages</dt>
            <dd style={{ margin: "3px 0" }}>{selected.artifact.pageCount}</dd>
          </div>
          <div>
            <dt style={{ color: "var(--muted)" }}>Uploaded</dt>
            <dd style={{ margin: "3px 0" }}>
              {date(selected.artifact.createdAt)}
            </dd>
          </div>
          <div>
            <dt style={{ color: "var(--muted)" }}>SHA-256</dt>
            <dd style={{ margin: "3px 0", overflowWrap: "anywhere" }}>
              {selected.artifact.contentSha256}
            </dd>
          </div>
        </dl>
      </Card>

      <Card
        title="Reviewed obligations"
        detail="Proposals do not become active until you approve them against the cited PDF pages."
      >
        {selected.obligations.length === 0 ? (
          <Empty>No reviewed obligations yet.</Empty>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {selected.obligations.map((obligation) => (
              <article
                key={obligation.id}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  padding: 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <strong>{obligation.title}</strong>
                  <span>{obligation.status}</span>
                </div>
                <p>{obligation.obligationText}</p>
                <blockquote
                  style={{
                    margin: "10px 0",
                    paddingLeft: 12,
                    borderLeft: "3px solid var(--accent)",
                    color: "var(--muted)",
                  }}
                >
                  Pages {obligation.pageStart}–{obligation.pageEnd}:{" "}
                  {obligation.citationText}
                </blockquote>
                {obligation.status === "proposed" ? (
                  <div style={{ display: "grid", gap: 9 }}>
                    <label htmlFor={`decision-reason-${obligation.id}`}>
                      <span style={{ display: "block", marginBottom: 6 }}>
                        Decision reason
                      </span>
                      <Input
                        id={`decision-reason-${obligation.id}`}
                        value={reason}
                        onChange={(event: ChangeEvent<HTMLInputElement>) =>
                          setReason(event.target.value)
                        }
                      />
                    </label>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Button
                        disabled={!reason.trim()}
                        onClick={() =>
                          void act(
                            () =>
                              adapter.decideObligation(
                                obligation,
                                "approve",
                                reason,
                              ),
                            "Obligation approved.",
                          )
                        }
                      >
                        <Check size={16} /> Approve
                      </Button>
                      <Button
                        variant="outline"
                        disabled={!reason.trim()}
                        onClick={() =>
                          void act(
                            () =>
                              adapter.decideObligation(
                                obligation,
                                "reject",
                                reason,
                              ),
                            "Obligation rejected.",
                          )
                        }
                      >
                        <X size={16} /> Reject
                      </Button>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Pins"
        detail="Pinning adds approved obligations to this agent or one chat. It never grants another person access."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(110px, 0.4fr) minmax(180px, 1fr) auto",
            gap: 8,
          }}
        >
          <select
            aria-label="Pin target type"
            value={targetType}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              setTargetType(event.target.value as "agent" | "chat")
            }
            style={{ minHeight: 44 }}
          >
            <option value="agent">Agent</option>
            <option value="chat">Chat</option>
          </select>
          <Input
            aria-label="Pin target ID"
            placeholder={
              targetType === "agent" ? "Agent ID" : "Chat or room ID"
            }
            value={targetId}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setTargetId(event.target.value)
            }
          />
          <Button
            disabled={!targetId.trim()}
            onClick={() =>
              void act(async () => {
                await adapter.pin({
                  artifactId: selected.artifact.id,
                  targetType,
                  targetId,
                });
                setPins(await adapter.listPins(selected.artifact.id));
              }, "Pin saved.")
            }
          >
            Pin
          </Button>
        </div>
        <ul style={{ padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
          {pins.map((pin) => (
            <li
              key={pin.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span>
                {pin.targetType}: {pin.targetId}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void act(async () => {
                    await adapter.unpin(pin.id);
                    setPins(await adapter.listPins(selected.artifact.id));
                  }, "Pin removed.")
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Guest access"
        detail="Preview the exact effects before issuing a bounded read grant to a verified guest."
      >
        <div style={{ display: "grid", gap: 9 }}>
          <label htmlFor="family-guest-entity-id">
            <span>Guest entity ID</span>
            <Input
              id="family-guest-entity-id"
              value={principalEntityId}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setPrincipalEntityId(event.target.value)
              }
            />
          </label>
          <label htmlFor="family-household-grant-id">
            <span>Household grant ID</span>
            <Input
              id="family-household-grant-id"
              value={householdGrantId}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setHouseholdGrantId(event.target.value)
              }
            />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              variant="outline"
              disabled={!principalEntityId || !householdGrantId}
              onClick={() =>
                void act(
                  async () =>
                    setPreview(
                      await adapter.previewGrant({
                        artifactId: selected.artifact.id,
                        principalEntityId,
                        householdGrantId,
                      }),
                    ),
                  "Preview ready.",
                )
              }
            >
              Preview permission
            </Button>
            <Button
              disabled={!preview?.allowed}
              onClick={() =>
                void act(
                  () =>
                    adapter.issueGrant({
                      artifactId: selected.artifact.id,
                      principalEntityId,
                      householdGrantId,
                    }),
                  "Guest grant issued.",
                )
              }
            >
              Issue grant
            </Button>
          </div>
          {preview ? (
            <div
              role="status"
              style={{
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 12,
              }}
            >
              <strong>
                {preview.allowed ? "Ready to grant" : "Cannot grant"}
              </strong>
              <p>
                {preview.denial?.message ??
                  "Guest can read artifact metadata and approved obligations only."}
              </p>
              <small>
                Pins do not grant access. Proposed and rejected obligations
                remain private.
              </small>
            </div>
          ) : null}
          <div
            style={{
              borderTop: "1px solid var(--border)",
              display: "grid",
              gap: 9,
              marginTop: 8,
              paddingTop: 16,
            }}
          >
            <strong>Revoke an existing grant</strong>
            <label htmlFor="family-revoke-grant-id">
              <span>Grant ID</span>
              <Input
                id="family-revoke-grant-id"
                value={revokeGrantId}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setRevokeGrantId(event.target.value)
                }
              />
            </label>
            <label htmlFor="family-revoke-reason">
              <span>Revocation reason</span>
              <Input
                id="family-revoke-reason"
                value={revokeReason}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  setRevokeReason(event.target.value)
                }
              />
            </label>
            <div>
              <Button
                variant="outline"
                disabled={!revokeGrantId.trim() || !revokeReason.trim()}
                onClick={() =>
                  void act(
                    () => adapter.revokeGrant(revokeGrantId, revokeReason),
                    "Guest grant revoked.",
                  )
                }
              >
                Revoke grant
              </Button>
            </div>
          </div>
        </div>
      </Card>
      {error ? <Unavailable message={error} /> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}

function CalendarPanel({
  state,
  adapter,
  refresh,
}: {
  state: FamilyOperationsSnapshot["calendarLinks"];
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (state.status === "unavailable")
    return <Unavailable message={state.message} />;
  if (state.data.length === 0)
    return (
      <Empty>
        No Eliza events are linked to Google yet. Create a link from an event in
        Calendar.
      </Empty>
    );
  const run = async (op: () => Promise<void>) => {
    try {
      setError(null);
      await op();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Calendar update failed",
      );
    }
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {state.data.map((link) => (
        <Card
          key={link.id}
          title={`Event ${link.localEventId}`}
          detail={`Google calendar ${link.providerCalendarId} · updated ${date(link.updatedAt)}`}
        >
          <p>
            <strong>Status:</strong> {link.state}
          </p>
          {link.state === "conflicted" ? (
            <div>
              <p role="alert">
                Both calendars changed. Choose which version should win.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button
                  onClick={() =>
                    void run(() =>
                      adapter.resolveCalendarConflict(
                        link.id,
                        "keep_eliza",
                        link.updatedAt,
                      ),
                    )
                  }
                >
                  Keep Eliza
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void run(() =>
                      adapter.resolveCalendarConflict(
                        link.id,
                        "keep_google",
                        link.updatedAt,
                      ),
                    )
                  }
                >
                  Keep Google
                </Button>
              </div>
            </div>
          ) : null}
          <Button
            variant="outline"
            onClick={() =>
              void run(() =>
                adapter.disconnectCalendar(link.id, link.updatedAt),
              )
            }
          >
            Disconnect, keep events
          </Button>
        </Card>
      ))}
      {error ? <Unavailable message={error} /> : null}
    </div>
  );
}

function SchoolPanel({
  state,
  adapter,
  refresh,
}: {
  state: FamilyOperationsSnapshot["school"];
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (state.status === "unavailable")
    return <Unavailable message={state.message} />;
  const workflow = state.data;
  const run = async (op: () => Promise<void>) => {
    try {
      setError(null);
      await op();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "School workflow failed",
      );
    }
  };
  return (
    <Card title={workflow.label} detail={`Source: ${workflow.sourceUrl}`}>
      <p>
        <strong>Status:</strong> {workflow.state} · checked{" "}
        {date(workflow.lastCheckedAt)}
      </p>
      {workflow.changes?.length ? (
        <ul>
          {workflow.changes.map((change) => (
            <li key={`${change.kind}:${change.label}`}>
              {change.kind}: {change.label}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No pending calendar differences.</Empty>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <Button onClick={() => void run(() => adapter.runSchoolWorkflow())}>
          <RefreshCw size={16} /> Run now
        </Button>
        {workflow.state === "awaiting_approval" && workflow.runId ? (
          <Button
            variant="outline"
            onClick={() =>
              void run(() =>
                adapter.approveSchoolDiff(workflow.runId as string),
              )
            }
          >
            <ShieldCheck size={16} /> Approve diff
          </Button>
        ) : null}
      </div>
      {error ? <Unavailable message={error} /> : null}
    </Card>
  );
}

function PacketPanel({
  state,
  adapter,
  refresh,
}: {
  state: FamilyOperationsSnapshot["packets"];
  adapter: FamilyOperationsAdapter;
  refresh: () => Promise<void>;
}) {
  const currentPeriod = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const [recipient, setRecipient] = useState("");
  const [recipientEntityId, setRecipientEntityId] = useState("");
  const [calendarPrivacyMode, setCalendarPrivacyMode] = useState<
    "full" | "times_only" | "busy_only"
  >("busy_only");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (state.status === "unavailable")
    return <Unavailable message={state.message} />;
  const generate = async () => {
    try {
      setError(null);
      await adapter.generatePacket(currentPeriod);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Packet generation failed",
      );
    }
  };
  const createDraft = async (packetId: string) => {
    try {
      setError(null);
      setNotice(null);
      await adapter.createPacketDraft({
        packetId,
        recipient: recipient.trim(),
        recipientEntityId: recipientEntityId.trim(),
        calendarPrivacyMode,
      });
      setNotice("Immutable guest-shareable draft created for review.");
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Draft creation failed",
      );
    }
  };
  const requestApproval = async (packetId: string, draftVersion: number) => {
    try {
      setError(null);
      setNotice(null);
      await adapter.requestPacketApproval(packetId, draftVersion);
      setNotice("Exact draft submitted to the owner approval queue.");
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Approval request failed",
      );
    }
  };
  const canCreateDraft =
    recipient.trim().length > 0 && recipientEntityId.trim().length > 0;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <Button onClick={() => void generate()}>
          Generate {currentPeriod} packet
        </Button>
      </div>
      <Card
        title="Guest delivery"
        detail="Choose the exact verified co-parent Entity and its iMessage address. The draft is privacy-filtered before it can enter the approval queue; this screen never sends it directly."
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: 12,
          }}
        >
          <label
            htmlFor="packet-recipient-entity"
            style={{ display: "grid", gap: 6 }}
          >
            <span>Recipient Entity ID</span>
            <Input
              id="packet-recipient-entity"
              value={recipientEntityId}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setRecipientEntityId(event.target.value)
              }
            />
          </label>
          <label
            htmlFor="packet-recipient-imessage"
            style={{ display: "grid", gap: 6 }}
          >
            <span>Verified iMessage address</span>
            <Input
              id="packet-recipient-imessage"
              value={recipient}
              placeholder="+15551234567 or Apple ID"
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setRecipient(event.target.value)
              }
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Calendar privacy</span>
            <select
              aria-label="Calendar privacy"
              value={calendarPrivacyMode}
              onChange={(event) =>
                setCalendarPrivacyMode(
                  event.target.value as "full" | "times_only" | "busy_only",
                )
              }
              style={{
                minHeight: 44,
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--txt)",
                padding: "0 12px",
              }}
            >
              <option value="busy_only">Busy only</option>
              <option value="times_only">Times only</option>
              <option value="full">Full event details</option>
            </select>
          </label>
        </div>
      </Card>
      {state.data.length === 0 ? (
        <Empty>No monthly packets have been generated.</Empty>
      ) : (
        state.data.map((packet) => (
          <Card
            key={`${packet.packetId}:${packet.version}`}
            title={`${packet.periodKey} · version ${packet.version}`}
            detail={`Built ${date(packet.createdAt)} · ${packet.status}`}
          >
            <ul>
              {packet.claims.map((claim) => (
                <li key={claim.id}>
                  <strong>{claim.section}:</strong> {claim.text}
                </li>
              ))}
            </ul>
            <div style={{ marginBottom: 12 }}>
              <Button
                variant="outline"
                disabled={!canCreateDraft}
                onClick={() => void createDraft(packet.packetId)}
              >
                Create privacy-filtered draft
              </Button>
            </div>
            {packet.draft ? (
              <details>
                <summary>
                  Review guest-shareable draft v{packet.draft.draftVersion}
                </summary>
                <pre style={{ whiteSpace: "pre-wrap", font: "inherit" }}>
                  {packet.draft.body}
                </pre>
                <p>
                  {packet.draft.approvalId
                    ? "Waiting in the shared approvals queue."
                    : "Draft has not been submitted for approval."}
                </p>
                {!packet.draft.approvalId ? (
                  <Button
                    onClick={() =>
                      void requestApproval(
                        packet.packetId,
                        packet.draft?.draftVersion as number,
                      )
                    }
                  >
                    Request owner approval
                  </Button>
                ) : null}
              </details>
            ) : (
              <Empty>No shareable draft yet.</Empty>
            )}
          </Card>
        ))
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <Unavailable message={error} /> : null}
    </div>
  );
}

export interface FamilyOperationsViewProps {
  adapter?: FamilyOperationsAdapter;
}

export function FamilyOperationsView({
  adapter = defaultFamilyOperationsAdapter,
}: FamilyOperationsViewProps) {
  const [tab, setTab] = useState<Tab>("agreements");
  const [snapshot, setSnapshot] = useState<FamilyOperationsSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await adapter.load());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Family Operations could not load",
      );
    } finally {
      setLoading(false);
    }
  }, [adapter]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <main
      style={{
        width: "100%",
        height: "100%",
        minHeight: 0,
        overflowY: "auto",
        color: "var(--txt)",
        background:
          "radial-gradient(circle at 8% 0%, var(--accent-subtle), transparent 35%), var(--bg)",
        padding: "clamp(14px, 3vw, 28px)",
      }}
    >
      <div
        style={{ maxWidth: 1040, margin: "0 auto", display: "grid", gap: 18 }}
      >
        <header>
          <p
            style={{
              margin: 0,
              color: "var(--accent)",
              fontWeight: 800,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              fontSize: 12,
            }}
          >
            Private owner workspace
          </p>
          <h1 style={{ margin: "6px 0", fontSize: "clamp(28px, 5vw, 44px)" }}>
            Family Operations
          </h1>
          <p style={{ margin: 0, color: "var(--muted)", maxWidth: 720 }}>
            Review the parenting agreement, calendar synchronization, school
            dates, and monthly coordination packet. Expenses are intentionally
            out of scope.
          </p>
        </header>
        <nav
          aria-label="Family Operations sections"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
              style={{
                minHeight: 48,
                borderRadius: 12,
                border: `1px solid ${tab === id ? "var(--accent)" : "var(--border)"}`,
                background: tab === id ? "var(--accent-subtle)" : "var(--card)",
                color: "var(--txt)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <Icon size={18} aria-hidden />
              {label}
            </button>
          ))}
        </nav>
        {loading && !snapshot ? (
          <p role="status">Loading Family Operations…</p>
        ) : null}
        {error ? <Unavailable message={error} /> : null}
        {snapshot ? (
          <div>
            {tab === "agreements" ? (
              <AgreementPanel
                state={snapshot.agreements}
                adapter={adapter}
                refresh={refresh}
              />
            ) : tab === "calendar" ? (
              <CalendarPanel
                state={snapshot.calendarLinks}
                adapter={adapter}
                refresh={refresh}
              />
            ) : tab === "school" ? (
              <SchoolPanel
                state={snapshot.school}
                adapter={adapter}
                refresh={refresh}
              />
            ) : (
              <PacketPanel
                state={snapshot.packets}
                adapter={adapter}
                refresh={refresh}
              />
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
}
