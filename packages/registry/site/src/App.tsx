import {
  AppWindow,
  Boxes,
  Cable,
  ExternalLink,
  Github,
  Info,
  Loader,
  Plug,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

type RegistryKind = "app" | "connector" | "plugin";
type RegistryOrigin = "builtin" | "third-party";

interface RegistryEntry {
  origin?: RegistryOrigin;
  support?: "first-party" | "community";
  builtIn?: boolean;
  firstParty?: boolean;
  thirdParty?: boolean;
  status?: string;
  kind?: RegistryKind;
  registryKind?: RegistryKind;
  directory?: string | null;
  git: {
    repo: string;
  };
  npm: {
    repo: string;
    v2: string | null;
  };
  supports: {
    v0: boolean;
    v1: boolean;
    v2: boolean;
  };
  description: string;
  homepage: string | null;
  topics: string[];
  stargazers_count: number;
  language: string;
  app?: {
    displayName: string;
    category: string;
    launchType: string;
    launchUrl: string | null;
    capabilities: string[];
  };
}

interface GeneratedRegistry {
  schemaVersion: string;
  lastUpdatedAt: string;
  counts: {
    total: number;
    builtin: number;
    thirdParty: number;
    app: number;
    connector: number;
    plugin: number;
  };
  registry: Record<string, RegistryEntry>;
}

interface RegistryItem {
  name: string;
  entry: RegistryEntry;
}

const kindIcons: Record<RegistryKind, typeof Plug> = {
  app: AppWindow,
  connector: Cable,
  plugin: Plug,
};

function githubUrl(entry: RegistryEntry): string {
  const base = `https://github.com/${entry.git.repo}`;
  if (!entry.directory) {
    return base;
  }
  return `${base}/tree/main/${entry.directory}`;
}

function originLabel(entry: RegistryEntry): string {
  return entry.origin === "third-party" || entry.thirdParty
    ? "Third party"
    : "Built in";
}

function supportLabel(entry: RegistryEntry): string {
  return entry.support === "community" || entry.thirdParty
    ? "Community"
    : "First party";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

const LoadingState = () => (
  <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50">
    <Loader className="mb-4 h-8 w-8 animate-spin text-orange-600" />
    <p className="text-sm text-zinc-500">Loading registry...</p>
  </div>
);

const ErrorState = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) => (
  <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 text-center">
    <Info className="mb-4 h-8 w-8 text-red-500" />
    <h1 className="mb-2 text-xl font-semibold text-zinc-950">
      Registry unavailable
    </h1>
    <p className="mb-5 max-w-md text-sm text-zinc-600">{error}</p>
    <button
      onClick={onRetry}
      className="rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
      type="button"
    >
      Retry
    </button>
  </div>
);

const Stat = ({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Boxes;
  label: string;
  value: number;
}) => (
  <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
    <Icon className="h-4 w-4 text-zinc-500" />
    <div>
      <div className="text-lg font-semibold text-zinc-950">{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  </div>
);

const FilterButton = ({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) => (
  <button
    className={`rounded-md px-3 py-2 text-sm font-medium ${
      active
        ? "bg-zinc-950 text-white"
        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
    }`}
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

const PluginCard = ({ item }: { item: RegistryItem }) => {
  const { name, entry } = item;
  const kind = entry.kind || "plugin";
  const KindIcon = kindIcons[kind] || Plug;

  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <KindIcon className="h-4 w-4 text-zinc-500" />
            <h2 className="break-words text-base font-semibold text-zinc-950">
              {entry.app?.displayName || name}
            </h2>
            <span className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600">
              {kind}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                entry.origin === "third-party"
                  ? "bg-blue-50 text-blue-700"
                  : "bg-emerald-50 text-emerald-700"
              }`}
            >
              {originLabel(entry)}
            </span>
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
              {supportLabel(entry)}
            </span>
          </div>
          <div className="mb-3 break-words font-mono text-xs text-zinc-500">
            {name}
          </div>
          <p className="line-clamp-2 text-sm leading-6 text-zinc-600">
            {entry.description || "No description provided."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
            href={githubUrl(entry)}
            target="_blank"
            rel="noopener noreferrer"
            title="Open repository"
          >
            <Github className="h-4 w-4" />
          </a>
          {entry.homepage && (
            <a
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:text-zinc-950"
              href={entry.homepage}
              target="_blank"
              rel="noopener noreferrer"
              title="Open homepage"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        {entry.npm.v2 && (
          <span className="rounded-md bg-zinc-100 px-2 py-1">
            v{entry.npm.v2}
          </span>
        )}
        {entry.directory && (
          <span className="rounded-md bg-zinc-100 px-2 py-1 font-mono">
            {entry.directory}
          </span>
        )}
        {entry.topics.slice(0, 5).map((topic) => (
          <span key={topic} className="rounded-md bg-zinc-100 px-2 py-1">
            {topic}
          </span>
        ))}
      </div>
    </article>
  );
};

const App = () => {
  const [data, setData] = useState<GeneratedRegistry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<"all" | RegistryOrigin>("all");
  const [kind, setKind] = useState<"all" | RegistryKind>("all");

  const fetchRegistry = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/generated-registry.json", {
        cache: "no-cache",
      });
      if (!response.ok) {
        throw new Error(`generated-registry.json returned ${response.status}`);
      }
      const registry = (await response.json()) as GeneratedRegistry;
      setData(registry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load registry");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRegistry();
  }, []);

  const items = useMemo<RegistryItem[]>(() => {
    if (!data) {
      return [];
    }
    return Object.entries(data.registry)
      .map(([name, entry]) => ({ name, entry }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [data]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter(({ name, entry }) => {
      const entryOrigin =
        entry.origin === "third-party" || entry.thirdParty
          ? "third-party"
          : "builtin";
      const entryKind = entry.kind || "plugin";
      if (origin !== "all" && entryOrigin !== origin) {
        return false;
      }
      if (kind !== "all" && entryKind !== kind) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const haystack = [
        name,
        entry.app?.displayName,
        entry.description,
        entry.git.repo,
        ...(entry.topics || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [items, kind, origin, query]);

  if (loading) {
    return <LoadingState />;
  }

  if (error || !data) {
    return (
      <ErrorState error={error || "No registry data"} onRetry={fetchRegistry} />
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950">
      <section className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-600">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                First-party packages are generated from elizaOS
              </div>
              <h1 className="text-3xl font-semibold tracking-normal sm:text-4xl">
                elizaOS Plugin Registry
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600">
                Built-in packages are first-party. Third-party packages are
                community registered and clearly labeled.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <a
                className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-zinc-700 hover:bg-zinc-50"
                href="/generated-registry.json"
              >
                <Boxes className="h-4 w-4" />
                JSON
              </a>
              <a
                className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-zinc-700 hover:bg-zinc-50"
                href="https://github.com/elizaos-plugins/registry/tree/main/entries/third-party"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="h-4 w-4" />
                Register
              </a>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat icon={Boxes} label="Total" value={data.counts.total} />
            <Stat
              icon={ShieldCheck}
              label="Built in"
              value={data.counts.builtin}
            />
            <Stat
              icon={Users}
              label="Third party"
              value={data.counts.thirdParty}
            />
            <Stat icon={AppWindow} label="Apps" value={data.counts.app} />
            <Stat icon={Plug} label="Plugins" value={data.counts.plugin} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-5 flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              className="h-10 w-full rounded-md border border-zinc-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-zinc-400"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search packages"
              type="search"
              value={query}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            <FilterButton
              active={origin === "all"}
              onClick={() => setOrigin("all")}
            >
              All
            </FilterButton>
            <FilterButton
              active={origin === "builtin"}
              onClick={() => setOrigin("builtin")}
            >
              Built in
            </FilterButton>
            <FilterButton
              active={origin === "third-party"}
              onClick={() => setOrigin("third-party")}
            >
              Third party
            </FilterButton>
          </div>
          <div className="flex flex-wrap gap-1">
            <FilterButton
              active={kind === "all"}
              onClick={() => setKind("all")}
            >
              Any kind
            </FilterButton>
            <FilterButton
              active={kind === "app"}
              onClick={() => setKind("app")}
            >
              Apps
            </FilterButton>
            <FilterButton
              active={kind === "connector"}
              onClick={() => setKind("connector")}
            >
              Connectors
            </FilterButton>
            <FilterButton
              active={kind === "plugin"}
              onClick={() => setKind("plugin")}
            >
              Plugins
            </FilterButton>
          </div>
        </div>

        <div className="mb-4 text-sm text-zinc-500">
          {filteredItems.length} packages shown. Updated{" "}
          {formatDate(data.lastUpdatedAt)}.
        </div>

        {filteredItems.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-6 py-12 text-center text-sm text-zinc-500">
            No packages match the current filters.
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredItems.map((item) => (
              <PluginCard key={item.name} item={item} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
};

export default App;
