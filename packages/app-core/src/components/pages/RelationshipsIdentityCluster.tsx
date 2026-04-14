import type { RelationshipsPersonDetail } from "../../api/client-types-relationships";

const CLUSTER_SIZE = 320;
const CLUSTER_CENTER = CLUSTER_SIZE / 2;
const OUTER_RADIUS = 108;
const INNER_RADIUS = 56;

function shortLabel(value: string, maxLength = 14): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function identityLabel(
  person: RelationshipsPersonDetail,
  index: number,
): string {
  const identity = person.identities[index];
  if (!identity) {
    return `${index + 1}`;
  }
  const handle = identity.handles[0];
  if (handle) {
    return shortLabel(handle.handle, 14);
  }
  return shortLabel(identity.names[0] ?? identity.entityId, 14);
}

export function RelationshipsIdentityCluster({
  person,
}: {
  person: RelationshipsPersonDetail;
}) {
  const total = person.identities.length;

  // Single identity or zero identities — show a compact hub-only layout
  // instead of the orbit, which looks awkward with one node dangling.
  if (total <= 1) {
    const singleIdentity = person.identities[0] ?? null;
    return (
      <div className="flex flex-col items-center gap-4">
        <svg
          viewBox={`0 0 ${CLUSTER_SIZE} ${CLUSTER_SIZE}`}
          className="h-72 w-72 max-w-full"
          role="img"
          aria-label={`${person.displayName} identity cluster`}
        >
          <defs>
            <radialGradient
              id="relationships-identity-cluster-fill"
              cx="50%"
              cy="38%"
              r="68%"
            >
              <stop offset="0%" stopColor="rgba(255,244,214,0.96)" />
              <stop offset="100%" stopColor="rgba(240,185,11,0.88)" />
            </radialGradient>
          </defs>
          <circle
            cx={CLUSTER_CENTER}
            cy={CLUSTER_CENTER}
            r={OUTER_RADIUS + 8}
            fill="rgba(240,185,11,0.06)"
            stroke="rgba(240,185,11,0.16)"
            strokeWidth={2}
          />
          <circle
            cx={CLUSTER_CENTER}
            cy={CLUSTER_CENTER}
            r={INNER_RADIUS + 16}
            fill="url(#relationships-identity-cluster-fill)"
            stroke="rgba(255,255,255,0.88)"
            strokeWidth={3}
          />
          <text
            x={CLUSTER_CENTER}
            y={CLUSTER_CENTER - 10}
            textAnchor="middle"
            className="fill-black text-sm font-semibold"
          >
            {shortLabel(person.displayName, 18)}
          </text>
          <text
            x={CLUSTER_CENTER}
            y={CLUSTER_CENTER + 8}
            textAnchor="middle"
            className="fill-black/70 text-2xs font-medium"
          >
            {singleIdentity
              ? (singleIdentity.platforms[0] ?? "single identity")
              : "No linked identities"}
          </text>
          <text
            x={CLUSTER_CENTER}
            y={CLUSTER_CENTER + 24}
            textAnchor="middle"
            className="fill-black/50 text-3xs"
          >
            {singleIdentity
              ? identityLabel(person, 0)
              : person.memberEntityIds.length === 1
                ? "1 entity"
                : `${person.memberEntityIds.length} entities`}
          </text>
        </svg>

        {singleIdentity ? (
          <div className="w-full">
            <div className="rounded-2xl border border-border/24 bg-card/35 px-3 py-2.5">
              <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted/70">
                {(singleIdentity.platforms[0] ?? "linked identity").replace(
                  /_/g,
                  " ",
                )}
              </div>
              <div className="mt-1 text-sm font-semibold text-txt">
                {singleIdentity.names[0] ?? singleIdentity.entityId}
              </div>
              <div className="mt-1 text-xs leading-5 text-muted">
                {singleIdentity.handles
                  .map((handle) => handle.handle)
                  .join(", ") || singleIdentity.entityId}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <svg
        viewBox={`0 0 ${CLUSTER_SIZE} ${CLUSTER_SIZE}`}
        className="h-72 w-72 max-w-full"
        role="img"
        aria-label={`${person.displayName} identity cluster`}
      >
        <defs>
          <radialGradient
            id="relationships-identity-cluster-fill"
            cx="50%"
            cy="38%"
            r="68%"
          >
            <stop offset="0%" stopColor="rgba(255,244,214,0.96)" />
            <stop offset="100%" stopColor="rgba(240,185,11,0.88)" />
          </radialGradient>
        </defs>

        <circle
          cx={CLUSTER_CENTER}
          cy={CLUSTER_CENTER}
          r={OUTER_RADIUS + 32}
          fill="rgba(240,185,11,0.09)"
          stroke="rgba(240,185,11,0.18)"
          strokeWidth={2}
        />
        <circle
          cx={CLUSTER_CENTER}
          cy={CLUSTER_CENTER}
          r={OUTER_RADIUS}
          fill="rgba(17,24,39,0.62)"
          stroke="rgba(240,185,11,0.26)"
          strokeWidth={2}
        />
        <circle
          cx={CLUSTER_CENTER}
          cy={CLUSTER_CENTER}
          r={INNER_RADIUS}
          fill="url(#relationships-identity-cluster-fill)"
          stroke="rgba(255,255,255,0.88)"
          strokeWidth={3}
        />
        <text
          x={CLUSTER_CENTER}
          y={CLUSTER_CENTER - 6}
          textAnchor="middle"
          className="fill-black text-sm font-semibold"
        >
          {shortLabel(person.displayName, 18)}
        </text>
        <text
          x={CLUSTER_CENTER}
          y={CLUSTER_CENTER + 14}
          textAnchor="middle"
          className="fill-black/70 text-2xs font-medium"
        >
          {person.memberEntityIds.length} linked identities
        </text>

        {person.identities.map((identity, index) => {
          const angle = -Math.PI / 2 + (index / total) * Math.PI * 2;
          const x = CLUSTER_CENTER + Math.cos(angle) * (OUTER_RADIUS - 18);
          const y = CLUSTER_CENTER + Math.sin(angle) * (OUTER_RADIUS - 18);
          const platform = identity.platforms[0] ?? "linked";

          return (
            <g key={identity.entityId}>
              <line
                x1={CLUSTER_CENTER}
                y1={CLUSTER_CENTER}
                x2={x}
                y2={y}
                stroke="rgba(240,185,11,0.34)"
                strokeWidth={2}
              />
              <circle
                cx={x}
                cy={y}
                r={18}
                fill="rgba(255,255,255,0.92)"
                stroke="rgba(240,185,11,0.6)"
                strokeWidth={2}
              />
              <text
                x={x}
                y={y - 3}
                textAnchor="middle"
                className="fill-black text-3xs font-semibold uppercase"
              >
                {shortLabel(platform, 8)}
              </text>
              <text
                x={x}
                y={y + 8}
                textAnchor="middle"
                className="fill-black/70 text-3xs font-medium"
              >
                {identityLabel(person, index)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="grid w-full gap-2 sm:grid-cols-2">
        {person.identities.map((identity) => (
          <div
            key={identity.entityId}
            className="rounded-2xl border border-border/24 bg-card/35 px-3 py-2.5"
          >
            <div className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted/70">
              {(identity.platforms[0] ?? "linked identity").replace(/_/g, " ")}
            </div>
            <div className="mt-1 text-sm font-semibold text-txt">
              {identity.names[0] ?? identity.entityId}
            </div>
            <div className="mt-1 text-xs leading-5 text-muted">
              {identity.handles.map((handle) => handle.handle).join(", ") ||
                identity.entityId}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
