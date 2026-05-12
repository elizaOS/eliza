# Cloud Frontend Dashboard Cleanup Plan

**Date:** 2026-05-12  
**Scope:** `/cloud/apps/frontend/src/dashboard/` (183 files, 44,734 LOC)  
**Severity:** High — This is the largest frontend surface area with heavy pattern duplication and hook/state sprawl.

---

## Executive Summary

The dashboard is a collection of 23 feature modules with minimal component sharing. **Key findings:**

1. **Connection/Platform Components** (2,700+ LOC): 9 nearly-identical integration components with duplicated fetch, error handling, and status UI.
2. **Data-Fetching Sprawl** (819+ hook instances): Every page re-implements fetch patterns, loading states, and cache logic.
3. **Form & Modal Duplication**: Settings, billing, and voice pages each implement their own forms (300–900 LOC) with no shared form builder.
4. **Table Components**: Containers, API Keys, and Analytics all render custom tables without a reusable abstraction.
5. **Skeleton/Empty-State Duplication**: Each section has its own loading skeleton and empty-state UI.

**Estimated refactor scope:**
- **High-impact consolidations:** 5,000–8,000 LOC reduction (20–30% of total)
- **Effort:** ~80–120 engineering hours
- **Wins:** Faster feature development, consistent UX, easier testing

---

## Directory Structure & File Inventory

### Top-Level Modules (by file count)

| Module | Files | Total LOC | Key Components |
|--------|-------|-----------|-----------------|
| `containers/` | 27 | ~2,900 | Sandbox table, agent table, deployment history, wallet |
| `settings/` | 27 | ~3,500 | 9 connection components, tabs interface, org panel |
| `apps/` | 22 | ~4,200 | App editor, automation, analytics, monetization |
| `admin/` | 11 | ~3,500 | Infrastructure dashboard (2,778 LOC), metrics, redemptions |
| `analytics/` | 14 | ~1,600 | Charts, filters, usage breakdown, cost analysis |
| `api-explorer/` | 10 | ~1,700 | API tester (1,118 LOC), auth, OpenAPI viewer |
| `billing/` | 10 | ~1,500 | Credit packs, pricing cards, payment modal |
| `api-keys/` | 6 | ~1,100 | Key table, summary, CRUD operations |
| `voices/` | 6 | ~1,700 | Voice clone form (767 LOC), studio, page wrapper |
| `video/` | 5 | ~1,000 | Generator, previews, page client |
| `image/` | 5 | ~1,600 | Image generator (1,247 LOC), display, advanced UI |
| `account/` | 6 | ~700 | Profile, security, org info, page wrapper |
| `invoices/` | 2 | ~150 | Invoice display, detail page |
| `documents/` | 5 | ~400 | Upload, management |
| `gallery/` | 3 | ~400 | Grid, page client, stats |
| `earnings/` | 3 | ~750 | Page wrapper, charts |
| `chat/` | 1 | ~39 | Redirect page |
| `mcps/` | 3 | ~800 | MCP section, page wrapper |
| `affiliates/` | 4 | ~700 | Page client, referral hook, page wrapper |
| `agents/` | 2 | ~500 | Agent detail, listing |
| `my-agents/` | 1 | ~23 | Redirect page |
| `chat-build/` | 1 | ~37 | Layout |
| `_components/` | 7 | ~730 | Dashboard card sections, metrics, action cards |
| **Root** | 2 | ~185 | Layout, main page |

---

## Detailed Analysis: Pattern Duplication

### 1. CONNECTION/PLATFORM COMPONENTS (2,768 LOC)

**Files:**
- `settings/_components/discord-connection.tsx` (345 LOC)
- `settings/_components/discord-gateway-connection.tsx` (872 LOC) — LARGE, multi-guild support
- `settings/_components/google-connection.tsx` (336 LOC)
- `settings/_components/microsoft-connection.tsx` (336 LOC)
- `settings/_components/twitter-connection.tsx` (293 LOC)
- `settings/_components/telegram-connection.tsx` (324 LOC)
- `settings/_components/twilio-connection.tsx` (371 LOC)
- `settings/_components/blooio-connection.tsx` (433 LOC)
- `settings/_components/whatsapp-connection.tsx` (458 LOC)

**Pattern observed:**
All follow this structure:
```tsx
1. useCallback(async (signal?) => { await fetch(...), setStatus, setLoading })
2. useEffect(() => { fetchStatus() }) — initial load & polling
3. Status badge (connected/disconnected/error) with same color scheme
4. AlertDialog confirmation for disconnect
5. Form inputs for credentials (apiKey, token, phoneNumber, etc.)
6. Error message display with toast
```

**Issues:**
- **No shared abstraction:** Each component independently handles fetch, error, retry, disconnect.
- **Inconsistent error UX:** Some use toast, some use inline errors, some use both.
- **Polling duplication:** Discord Gateway, Telegram, and WhatsApp all implement polling; no shared interval hook.
- **Status color duplication:** Each redefines connected/pending/error badge styles.

**Recommendation:** Extract a `<ConnectionManager>` component factory:
```tsx
// libraries/cloud-ui-dashboard/connection-manager.tsx
export function useConnectionManager<T>(config: {
  endpoint: string;
  platform: 'discord' | 'google' | 'telegram' | ... ;
  onStatusChange?: (status: ConnectionStatus) => void;
}) { /* shared logic */ }

export function ConnectionCard<T extends ConnectionData>({
  platform, status, config, onDisconnect, children /* slot for platform-specific UI */
})
```

**Impact:**
- **Reduce to ~1,200 LOC** (150 LOC shared hook + ~150 LOC shared card + 25–50 LOC per platform)
- **Consistency:** Unified error handling, status badges, retry behavior
- **Testability:** Test fetch logic once; platforms add only custom credentials/validation

---

### 2. DATA-FETCHING PATTERN SPRAWL

**Scope:** 819+ hook instances across 101 files (45% of dashboard files)

**Pattern observed:**
Every module independently implements:
```tsx
const [data, setData] = useState(null);
const [isLoading, setIsLoading] = useState(true);
const [error, setError] = useState(null);

const fetch = useCallback(async (signal?) => {
  setLoading(true);
  try {
    const res = await fetch(endpoint, { signal });
    if (!res.ok) throw new Error(...);
    const json = await res.json();
    setData(json);
  } catch (e) {
    if (e.name !== 'AbortError') {
      setError(e.message);
      toast.error('Failed to load...');
    }
  } finally {
    setLoading(false);
  }
}, []);

useEffect(() => { fetch(); }, [fetch]);
```

**Examples:**
- `settings/_components/discord-gateway-connection.tsx:136–180` (fetchConnections, fetchCharacters, fetchData)
- `containers/_components/eliza-agents-table.tsx:215–260` (custom polling loop)
- `gallery/_components/gallery-page-client.tsx:85–145` (tab-based lazy fetch)
- `billing/_components/billing-tab.tsx:45–100` (multiple fetch functions)
- `analytics/_components/UsageChartLazy.tsx` (on-demand chart load)

**Issues:**
- **No cache/dedup:** Each page re-fetches on mount; no request coalescing or SWR-style stale-while-revalidate.
- **Inconsistent abort handling:** Some use AbortController, some don't; some clear errors on abort, some don't.
- **Manual polling:** Several components implement polling manually (setInterval + cleanup) — hard to coordinate.
- **No request coalescing:** Parallel requests to same endpoint spawn multiple fetches.

**Recommendation:** Introduce a `useApi` hook (or adopt TanStack Query if not already in use):

```tsx
// hooks/use-api.ts
export function useApi<T>(endpoint: string, options?: {
  refetchInterval?: number | false;
  onError?: (error: Error) => void;
  dedupKey?: string; // coalesce identical requests
}) {
  return {
    data: T | null,
    isLoading: boolean,
    error: Error | null,
    refetch: () => Promise<T>,
    isRefetching: boolean,
  };
}

// Usage:
const { data: connections, isLoading, refetch } = useApi('/api/discord/connections');
```

**Files affected:**
- `settings/_components/*.tsx` (9 files, ~70 fetch functions)
- `containers/_components/*.tsx` (8 files, ~40 fetch functions)
- `gallery/_components/gallery-page-client.tsx` (3 fetch functions)
- `billing/_components/billing-tab.tsx` (3 fetch functions)
- `admin/_components/infrastructure-dashboard.tsx` (10+ fetch operations)

**Impact:**
- **Reduce to ~400 LOC** (shared hook) + 30–50 LOC per component (was 80–150)
- **Cache:** Automatic dedup & stale-while-revalidate
- **Developer UX:** Less boilerplate; easier to debug
- **Performance:** Fewer wasted requests; shared cache reduces API load

---

### 3. FORM COMPONENTS (2,500+ LOC)

**Major forms:**
- `settings/_components/discord-gateway-connection.tsx:300–600` (connection form + character select)
- `voices/_components/voice-clone-form.tsx` (767 LOC — multi-tab, upload, recording, advanced settings)
- `apps/_components/automation-edit-sheet.tsx` (898 LOC — discord/telegram/twitter config)
- `account/_components/profile-form.tsx` (664 LOC — user settings, email, password)
- `image/_components/image-generator-advanced.tsx` (1,247 LOC — massive config UI with sliders, inputs, tabs)

**Pattern observed:**
- Manual `useState` for each field: `const [name, setName] = useState(''); const [bio, setBio] = useState(''); ...`
- Custom validation inline in submit handler
- Dialog/Sheet wrapper with custom open/close logic
- No shared form components; each builds own input layout
- Loading/error states scattered throughout JSX

**Example (from voice-clone-form.tsx):**
```tsx
const [formData, setFormData] = useState<FormData>(DEFAULT_FORM_DATA);
const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_SETTINGS);
const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
const [isProcessing, setIsProcessing] = useState(false);
const [error, setError] = useState<string | null>(null);

const handleInputChange = (field: keyof FormData, value: string) => {
  setFormData(prev => ({ ...prev, [field]: value }));
};

const handleSubmit = async () => {
  setIsProcessing(true);
  try {
    // validation
    // API call
    setError(null);
  } catch (e) {
    setError(e.message);
  } finally {
    setIsProcessing(false);
  }
};
```

**Issues:**
- **Field-by-field state explosion:** 20+ useState calls in large forms
- **No schema validation:** Validation scattered or missing; inconsistent UX
- **Duplication:** Credit/email input formatting, password validation, etc. reimplemented across forms
- **Accessibility:** Form labels, error messages, ARIA attributes are ad-hoc
- **Testing:** Hard to unit-test form logic separate from React

**Recommendation:** Introduce a form builder or adopt `react-hook-form` + `zod`:

```tsx
// Option 1: Simple form hook
export function useForm<T extends Record<string, any>>(
  initial: T,
  onSubmit: (data: T) => Promise<void>,
  validate?: (data: T) => Record<string, string>
) {
  const [data, setData] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate?.(data) || {};
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    setIsSubmitting(true);
    try {
      await onSubmit(data);
    } catch (e) {
      setErrors({ _submit: e.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    data,
    errors,
    isSubmitting,
    setField: (key: keyof T, value: any) => setData(p => ({ ...p, [key]: value })),
    handleSubmit,
  };
}

// Usage:
const form = useForm(
  { name: '', email: '' },
  async (data) => {
    await api.createUser(data);
  },
  (data) => ({
    ...(data.name.length < 2 ? { name: 'Min 2 chars' } : {}),
    ...(!data.email.includes('@') ? { email: 'Invalid email' } : {}),
  })
);

<form onSubmit={form.handleSubmit}>
  <Input
    value={form.data.name}
    onChange={(e) => form.setField('name', e.target.value)}
    error={form.errors.name}
  />
</form>
```

**Impact:**
- **Reduce form components by 40–60%** (shared hook logic + schema)
- **Consistency:** Same validation UX, error display, loading states
- **Testability:** Decouple form logic from React rendering
- **Maintainability:** Schema-driven validation is DRY and easier to refactor

---

### 4. TABLE COMPONENTS (1,200+ LOC)

**Tables:**
- `containers/_components/eliza-agents-table.tsx` (892 LOC)
- `containers/_components/containers-table.tsx` (544 LOC)
- `api-keys/_components/api-keys-table.tsx` (346 LOC)
- `analytics/_components/top-users-table.tsx` (103 LOC)

**Pattern observed:**
- Manual column definition with array of objects or JSX
- Inline sort/filter logic with state
- Custom row rendering (status badges, action buttons)
- Search/filter scattered through component

**Example (eliza-agents-table.tsx):**
```tsx
const [sortBy, setSortBy] = useState<'status' | 'created'>('status');
const [searchFilter, setSearchFilter] = useState('');
const [filteredRows, setFilteredRows] = useState(sandboxes);

const sortedAndFiltered = useMemo(() => {
  let rows = sandboxes.filter(r => 
    r.agent_name?.toLowerCase().includes(searchFilter.toLowerCase())
  );
  return rows.sort((a, b) => ...);
}, [sandboxes, searchFilter, sortBy]);

return (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead onClick={() => setSortBy('status')}>Status</TableHead>
        ...
      </TableRow>
    </TableHeader>
    <TableBody>
      {sortedAndFiltered.map(row => (
        <TableRow key={row.id}>
          <StatusCell row={row} />
          ...
        </TableRow>
      ))}
    </TableBody>
  </Table>
);
```

**Issues:**
- **Inconsistent sort UX:** Some tables have sort arrows, some don't; some sort by default, others by click
- **No pagination:** Tables re-render all rows; no virtualization for 100+ rows
- **Duplicate action buttons:** Delete, edit, view buttons styled/positioned differently
- **No reusable cell components:** Status badges, timestamps, costs calculated inline

**Recommendation:** Create a `<DataTable>` component:

```tsx
// components/data-table.tsx
export interface TableColumn<T> {
  key: keyof T;
  label: string;
  sortable?: boolean;
  render?: (value: T[keyof T], row: T) => ReactNode;
  width?: string;
}

export function DataTable<T extends { id: string }>({
  columns,
  data,
  onRowClick?,
  actions?,
  isLoading,
  error,
}) {
  const [sort, setSort] = useState<{ key: string; asc: boolean } | null>(null);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let rows = data.filter(row => /* search logic */);
    if (sort) {
      rows.sort((a, b) => /* compare a[sort.key] vs b[sort.key] */);
    }
    return rows;
  }, [data, search, sort]);

  return (
    <div>
      <Input placeholder="Search..." onChange={(e) => setSearch(e.target.value)} />
      <Table>
        <TableHeader>
          {columns.map(col => (
            <TableHead
              key={col.key}
              onClick={() => col.sortable && setSort({
                key: col.key as string,
                asc: sort?.key === col.key ? !sort.asc : true,
              })}
              className={col.sortable ? 'cursor-pointer' : ''}
            >
              {col.label}
              {sort?.key === col.key && <ArrowUpDown className="ml-1 h-4 w-4" />}
            </TableHead>
          ))}
          {actions && <TableHead>Actions</TableHead>}
        </TableHeader>
        <TableBody>
          {isLoading && <TableRow><TableCell colSpan={columns.length}>Loading...</TableCell></TableRow>}
          {filtered.map(row => (
            <TableRow key={row.id} onClick={() => onRowClick?.(row)}>
              {columns.map(col => (
                <TableCell key={col.key as string}>
                  {col.render ? col.render(row[col.key], row) : row[col.key]}
                </TableCell>
              ))}
              {actions && (
                <TableCell>
                  {actions.map(action => (
                    <Button key={action.label} onClick={() => action.onClick(row)}>
                      {action.label}
                    </Button>
                  ))}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// Usage:
<DataTable
  columns={[
    { key: 'name', label: 'Name', sortable: true },
    { key: 'status', label: 'Status', render: (val) => <StatusBadge status={val} /> },
  ]}
  data={agents}
  actions={[
    { label: 'Edit', onClick: (row) => editAgent(row.id) },
    { label: 'Delete', onClick: (row) => deleteAgent(row.id) },
  ]}
/>
```

**Impact:**
- **Reduce table components by 50–70%** (consolidate to 100 LOC shared component)
- **UX consistency:** Same sort/filter/action UX across all tables
- **Virtualization ready:** Easy to add windowing for large datasets
- **Accessible:** Shared component can enforce ARIA attributes

---

### 5. SKELETON/EMPTY-STATE DUPLICATION (600+ LOC)

**Skeletons:**
- `_components/agents-section.tsx:128–163` (agent grid skeleton)
- `containers/_components/containers-skeleton.tsx` (59 LOC)
- `apps/_components/apps-skeleton.tsx` (8 LOC)

**Empty states:**
- `_components/agents-section.tsx:107–125` (agents empty state)
- `containers/_components/containers-empty-state.tsx` (68 LOC)
- `apps/_components/apps-empty-state.tsx` (17 LOC)
- `billing/success/Page.tsx` (custom success state)

**Pattern observed:**
```tsx
export function AgentsSectionSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(4)].map((_,i) => (
        <div key={i} className="h-24 bg-white/10 animate-pulse rounded" />
      ))}
    </div>
  );
}

export function AgentsEmptyState() {
  return (
    <EmptyState
      title="No agents yet"
      action={<BrandButton asChild>...</BrandButton>}
    />
  );
}
```

**Issues:**
- **Repetition:** Each page defines its own skeleton with slightly different dimensions
- **No shared layout:** Some use `grid`, some use `flex`; skeleton aspect ratios don't match final content
- **Accessibility:** Skeletons are not announced to screen readers (OK if role="presentation")
- **Maintenance:** Updating skeleton to match UI changes requires edits in 5+ places

**Recommendation:** Create skeleton & empty-state factories:

```tsx
// components/ui/skeleton-factory.tsx
export function Skeleton({
  aspect = 'square', // 'square' | 'wide' | 'card' | 'row'
  count = 4,
  grid,
}) {
  const cls = {
    square: 'aspect-square',
    wide: 'aspect-video',
    card: 'h-48',
    row: 'h-16',
  }[aspect];

  return (
    <div className={grid ? `grid ${grid} gap-4` : ''}>
      {[...Array(count)].map((_, i) => (
        <div key={i} className={`${cls} bg-white/10 animate-pulse rounded`} />
      ))}
    </div>
  );
}

export function EmptyStatePlaceholder({
  title, description, icon: Icon, action, image
}) {
  return (
    <div className="text-center py-12">
      {Icon && <Icon className="mx-auto h-12 w-12 text-white/30 mb-4" />}
      {image && <img src={image} alt="" className="mx-auto h-24 w-24 mb-4" />}
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-sm text-white/50 mt-1">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// Usage:
<Skeleton aspect="card" count={4} grid="grid-cols-4" /> // agents skeleton
<EmptyStatePlaceholder
  title="No agents yet"
  icon={MessageSquare}
  action={<BrandButton>Create</BrandButton>}
/>
```

**Impact:**
- **Reduce duplication by 200 LOC** (centralized factories)
- **Consistency:** All skeletons animate together; proportions match final UI
- **Maintenance:** One place to update skeleton styling (animation, colors, etc.)

---

### 6. MODAL/DIALOG SPRAWL (400+ LOC)

**Dialogs:**
- `settings/_components/organization/invite-member-dialog.tsx` (custom dialog for invites)
- `containers/_components/create-eliza-agent-dialog.tsx` (569 LOC)
- `admin/_components/infrastructure-dashboard.tsx:500–700` (edit/delete node dialogs)
- `video/_components/video-page-client.tsx` (delete confirmation)
- `gallery/_components/gallery-grid.tsx` (fullscreen preview dialog)

**Pattern observed:**
- Each component duplicates Dialog/AlertDialog + form + handlers
- Confirmation dialogs have same structure: title, description, cancel/confirm buttons
- Custom modal header/footer styling per page

**Example:**
```tsx
const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

<AlertDialog open={!!deleteTargetId} onOpenChange={(open) => {
  if (!open) setDeleteTargetId(null);
}}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete Agent?</AlertDialogTitle>
    </AlertDialogHeader>
    <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={() => deleteAgent(deleteTargetId)}>Delete</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Recommendation:** Create reusable dialog helpers:

```tsx
// hooks/use-dialog.ts
export function useDialog<T = void>(onConfirm?: (data?: T) => Promise<void>) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [data, setData] = useState<T | undefined>();

  const open = (initialData?: T) => {
    setData(initialData);
    setIsOpen(true);
  };

  const confirm = async (finalData?: T) => {
    setIsLoading(true);
    try {
      await onConfirm?.(finalData || data);
      setIsOpen(false);
    } finally {
      setIsLoading(false);
    }
  };

  return { isOpen, setIsOpen, data, setData, isLoading, open, confirm };
}

// Usage:
const deleteDialog = useDialog(async (id) => {
  await api.deleteAgent(id);
  toast.success('Agent deleted');
});

<AlertDialog open={deleteDialog.isOpen} onOpenChange={deleteDialog.setIsOpen}>
  <AlertDialogContent>
    <AlertDialogTitle>Delete Agent?</AlertDialogTitle>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onClick={() => deleteDialog.confirm(agentId)}
        disabled={deleteDialog.isLoading}
      >
        {deleteDialog.isLoading ? 'Deleting...' : 'Delete'}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Impact:**
- **Reduce dialog boilerplate by 150 LOC** (centralized open/close/loading logic)
- **Consistency:** Same loading UI, error handling, animation timing

---

## High-Level Consolidation Plan

### Phase 1: Data Fetching (Week 1, ~30 hours)

**Objective:** Reduce fetch boilerplate and enable cache/dedup.

**Deliverables:**
1. Create `hooks/use-api.ts` with shared fetch logic, abort handling, and optional polling
2. Audit all 40+ fetch functions across containers, settings, analytics
3. Convert top 10 high-traffic pages to `useApi`
4. Add integration with TanStack Query if not already in use (check `package.json`)

**Files to modify:**
- `settings/_components/discord-gateway-connection.tsx` (3 fetch functions)
- `containers/_components/eliza-agents-table.tsx` (polling logic)
- `billing/_components/billing-tab.tsx` (3 fetch functions)
- `gallery/_components/gallery-page-client.tsx` (lazy loading)

**Expected wins:**
- 300+ LOC reduction
- Fewer re-fetches on re-mount
- Consistent error UX

---

### Phase 2: Connection Manager (Week 2, ~40 hours)

**Objective:** Consolidate 9 platform-specific connection components.

**Deliverables:**
1. Create `components/connection-manager/useConnectionManager.ts` hook
2. Create `components/connection-manager/ConnectionCard.tsx` base component
3. Create platform-specific overrides (Discord, Google, Telegram, etc.) as thin wrappers
4. Migrate all 9 connection components to use the new abstraction

**Files to create:**
- `components/connection-manager/useConnectionManager.ts` (~150 LOC)
- `components/connection-manager/ConnectionCard.tsx` (~200 LOC)
- `components/connection-manager/platforms/discord.tsx` (~80 LOC)
- `components/connection-manager/platforms/google.tsx` (~50 LOC)
- ... (similar for other 7 platforms)

**Files to remove (or reduce):**
- `settings/_components/discord-connection.tsx` → 50 LOC platform config
- `settings/_components/google-connection.tsx` → 40 LOC platform config
- ... (similar refactor for all 9)

**Expected wins:**
- 1,500+ LOC reduction (from 2,768 → 1,200)
- Unified status badges, error handling, disconnect flow
- Easier to add new platforms (just define endpoint + fields)

---

### Phase 3: Form Builder (Week 3, ~50 hours)

**Objective:** Create reusable form hook and validation schema system.

**Deliverables:**
1. Create `hooks/useForm.ts` with field state, validation, error display
2. Create schema validation (zod or similar) for common fields (email, password, API key, etc.)
3. Migrate 5 large forms to use the new system:
   - `voices/voice-clone-form.tsx` (767 LOC)
   - `apps/automation-edit-sheet.tsx` (898 LOC)
   - `account/profile-form.tsx` (664 LOC)
   - `settings/_components/discord-gateway-connection.tsx` (partial: connection form, 200 LOC)
   - `billing/billing-tab.tsx` (partial: payment form, 150 LOC)

**Files to create:**
- `hooks/useForm.ts` (~200 LOC)
- `lib/validation/schemas.ts` (~150 LOC, email/password/api-key validators)
- `components/form-field.tsx` (~100 LOC, shared label + input + error wrapper)

**Files to modify:**
- `voices/_components/voice-clone-form.tsx` (767 → 350 LOC, remove field state duplication)
- `apps/_components/automation-edit-sheet.tsx` (898 → 500 LOC, use form hook)
- `account/_components/profile-form.tsx` (664 → 400 LOC, use form hook + validation schema)

**Expected wins:**
- 1,000+ LOC reduction across 5 forms
- Consistent validation/error UX
- Easier to test form logic separately from render

---

### Phase 4: Data Table (Week 4, ~35 hours)

**Objective:** Consolidate 4 custom table implementations.

**Deliverables:**
1. Create `components/data-table.tsx` with column definition, sort, search, virtualization hooks
2. Migrate 4 tables to use the new component
3. Add cell renderers for common types (status badge, currency, timestamp, etc.)

**Files to create:**
- `components/data-table.tsx` (~250 LOC)
- `components/data-table-cells.tsx` (~150 LOC, status badge, cost cell, timestamp cell)

**Files to modify:**
- `containers/_components/eliza-agents-table.tsx` (892 → 200 LOC, use DataTable)
- `containers/_components/containers-table.tsx` (544 → 150 LOC, use DataTable)
- `api-keys/_components/api-keys-table.tsx` (346 → 100 LOC, use DataTable)
- `analytics/_components/top-users-table.tsx` (103 → 50 LOC, use DataTable)

**Expected wins:**
- 1,000+ LOC reduction
- Consistent sort/filter/action UX
- Easier to add virtualization later

---

### Phase 5: Skeleton & Empty-State Factories (Week 5, ~20 hours)

**Objective:** Deduplicate skeleton and empty-state components.

**Deliverables:**
1. Create `components/ui/skeleton-factory.tsx` with aspect ratio presets
2. Create `components/ui/empty-state-factory.tsx` with icon/image slots
3. Audit all 15+ skeleton/empty-state usages and consolidate

**Files to create:**
- `components/ui/skeleton-factory.tsx` (~80 LOC)
- `components/ui/empty-state-factory.tsx` (~80 LOC)

**Files to modify:**
- `_components/agents-section.tsx` (reduce skeleton code)
- `containers/_components/containers-skeleton.tsx` (consolidate to factory)
- `apps/_components/apps-skeleton.tsx` (consolidate to factory)

**Expected wins:**
- 200+ LOC reduction
- Consistent animation/timing across all skeletons
- Single place to update skeleton styling

---

### Phase 6: Modal & Dialog Helpers (Week 6, ~15 hours)

**Objective:** Reduce dialog open/close/loading boilerplate.

**Deliverables:**
1. Create `hooks/use-dialog.ts` helper hook for managing dialog state + loading
2. Create `hooks/use-confirmation-dialog.ts` for standard confirm/cancel dialogs
3. Migrate 5+ dialog usages to use the new hooks

**Files to create:**
- `hooks/use-dialog.ts` (~80 LOC)
- `hooks/use-confirmation-dialog.ts` (~60 LOC)

**Files to modify:**
- `containers/_components/create-eliza-agent-dialog.tsx` (partial: extraction of dialog state logic)
- `admin/_components/infrastructure-dashboard.tsx` (partial: 3 dialogs → use hook)

**Expected wins:**
- 200+ LOC reduction in dialog-heavy components
- Consistent delete/confirm UX
- Easier to add animations, transitions

---

## Summary of Impact

| Phase | Files Modified | LOC Reduction | Effort (hours) |
|-------|----------------|---------------|----------------|
| 1. Data Fetching | 10 | 300+ | 30 |
| 2. Connection Manager | 12 | 1,500+ | 40 |
| 3. Form Builder | 5 | 1,000+ | 50 |
| 4. Data Table | 4 | 1,000+ | 35 |
| 5. Skeleton/Empty-State | 10 | 200+ | 20 |
| 6. Modal/Dialog | 8 | 200+ | 15 |
| **Total** | **49** | **4,200+** | **190** |

**Estimated overall savings:** 4,200+ LOC (9–12% of total 44,734 LOC dashboard)

**Quality improvements:**
- Reduced cognitive load (fewer variations of same pattern)
- Easier onboarding (fewer patterns to learn)
- Faster feature development (reuse instead of copy-paste)
- Better testing (shared logic is tested once)
- Consistent UX (same error messages, loading UI, colors)

---

## Cross-Cutting Findings

### 1. Pages vs. Dashboard Relationship

**Finding:** There are both `/pages/` (29 files, ~2,500 LOC) and `/dashboard/` (183 files, ~44,734 LOC) in the frontend.

**Question:** What is the relationship? Are pages a legacy structure, or do they serve a different purpose?

**Recommendation:** Document the relationship in `docs/frontend-architecture.md`. If pages are legacy:
- Create a migration plan to move functionality into dashboard
- Deprecate old pages module

If pages are for public-facing content:
- Clearly separate public pages from admin dashboard
- Avoid sharing internal dashboard logic with public pages

---

### 2. Render Performance & Telemetry

**Finding:** Several large components (2,000–2,800 LOC) likely trigger expensive re-renders:
- `admin/_components/infrastructure-dashboard.tsx` (2,778 LOC, ~10 tabs with massive nested state)
- `image/_components/image-generator-advanced.tsx` (1,247 LOC, ~20 input fields, each with onChange handlers)
- `apps/_components/automation-edit-sheet.tsx` (898 LOC, nested form state, character/guild/channel dropdowns)

**Recommendation:** Add performance telemetry:

1. Instrument large components with `useWhyDidYouUpdate` (dev-only) or React DevTools Profiler
2. Identify unnecessary re-renders (e.g., parent state change → re-render child that doesn't use it)
3. Apply memoization (memo, useMemo, useCallback) strategically

**High-value targets:**
- `infrastructure-dashboard.tsx`: Memoize tab content components to avoid re-rendering all tabs on toggle
- `image-generator-advanced.tsx`: Split into smaller form sections; memoize sliders/inputs
- `automation-edit-sheet.tsx`: Memoize guild/channel selectors; cache API responses

---

### 3. Feature Flags & Experimental Code

**Finding:** No evidence of feature flags or experiment branches in dashboard (no conditional imports, no feature contexts).

**Recommendation:** Consider adding a feature flag system for:
- Rolling out new connection types (e.g., LinkedIn, Slack) without merge-blocking
- A/B testing UI changes (e.g., new table sorting UX)
- Gradual migration to new form builder (enable for new forms first, migrate old forms later)

**Pattern:**
```tsx
const useFeatureFlag = (flag: 'new-form-builder' | 'experimental-table') => {
  const user = useUser();
  return user?.beta_features?.includes(flag) ?? false;
};

// Usage:
if (useFeatureFlag('new-form-builder')) {
  return <NewVoiceCloneForm />;
} else {
  return <VoiceCloneForm />;
}
```

---

### 4. TypeScript & Type Safety

**Finding:** Generally good type coverage (no widespread `any` abuse detected). Observed only 1 `as any` instance.

**Recommendation:** Maintain strict types; consider adding stricter tsconfig:

```json
{
  "compilerOptions": {
    "noUncheckedIndexedAccess": true,
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true
  }
}
```

---

### 5. Error Handling Consistency

**Finding:** Error handling varies widely:
- Some components toast errors automatically
- Some display errors inline
- Some do both
- Some silently log to console (19 console.log/error calls)

**Recommendation:** Establish error handling guidelines:

1. **API errors:** Always toast (brief message); optionally show detailed error in sidebar/toast expandable
2. **Form validation errors:** Show inline (under field) + optionally toast summary
3. **Critical errors:** Use ErrorBoundary for component-level crash recovery
4. **Console logging:** Only for dev (wrap in `if (process.env.NODE_ENV === 'development')`)

**Shared error handler:**
```tsx
export function useErrorHandler() {
  return useCallback((error: Error, context: 'fetch' | 'form' | 'api') => {
    if (context === 'fetch') {
      toast.error(error.message || 'Failed to load data');
      logTelemetry('fetch_error', { message: error.message });
    } else if (context === 'form') {
      // Return error object to render inline
      return { field: 'general', message: error.message };
    } else {
      toast.error('An unexpected error occurred');
    }
  }, []);
}
```

---

### 6. Unused Files & Dead Code

**Recommendation:** Run an audit to identify unused exports:

```bash
# Find .tsx/.ts files with no imports from other files
grep -r "^export " dashboard --include="*.tsx" | \
  while read line; do
    file=$(echo "$line" | cut -d: -f1)
    name=$(echo "$line" | sed 's/.*export[^a-zA-Z]*//; s/[({].*//')
    if ! grep -r "$name" dashboard --include="*.tsx" | grep -v "$file" > /dev/null; then
      echo "Unused export in $file: $name"
    fi
  done
```

This is a preliminary check; requires manual review to avoid false positives.

---

## Implementation Roadmap

**Recommended sequence (6 weeks, ~190 hours):**

1. **Week 1:** Data Fetching hook + audit → 30 hours
2. **Week 2:** Connection Manager refactor → 40 hours
3. **Week 3:** Form Builder hook + migration → 50 hours
4. **Week 4:** Data Table component + migration → 35 hours
5. **Week 5:** Skeleton/Empty-State factories → 20 hours
6. **Week 6:** Modal/Dialog helpers + polish → 15 hours

**Parallel tracks (no blocking dependencies):**
- Feature flag infrastructure (Week 1–2)
- Performance telemetry setup (Week 1–2)
- Error handling guidelines + audit (Week 2–3)

**Checkpoints:**
- After each phase, run `npm run build` and `npm run test` to catch regressions
- After Week 3, performance benchmark (Core Web Vitals, React profiler snapshot)
- Final PR review: ensure shared components are tested, documented, and backwards-compatible

---

## Recommendations for Ongoing Health

1. **Enforce component reuse:** During code review, flag re-implementations of tables, forms, dialogs
2. **Shared component ownership:** Assign a single engineer to own `components/` directory
3. **Monthly refactoring sprint:** Reserve 20% of sprint for consolidating new duplication patterns
4. **Documentation:** Keep `docs/dashboard-component-guide.md` up-to-date with examples of how to build common patterns

---

## Appendix: File Index

### Largest Files (>500 LOC)

| File | LOC | Module | Issue |
|------|-----|--------|-------|
| `admin/_components/infrastructure-dashboard.tsx` | 2,778 | admin | Monolithic; needs splitting, memoization |
| `image/_components/image-generator-advanced.tsx` | 1,247 | image | Large form; candidate for form builder |
| `api-explorer/_components/api-tester.tsx` | 1,118 | api-explorer | API request UI; duplication risk with similar testing tools |
| `apps/_components/automation-edit-sheet.tsx` | 898 | apps | Form with dynamic fields; candidate for form builder |
| `containers/_components/eliza-agents-table.tsx` | 892 | containers | Large table; candidate for DataTable consolidation |
| `apps/_components/app-domains.tsx` | 878 | apps | Domain/URL management form |
| `settings/_components/discord-gateway-connection.tsx` | 872 | settings | Connection manager; candidate for consolidation |
| `admin/_components/admin-metrics-client.tsx` | 833 | admin | Metrics dashboard; check for polling duplication |
| `apps/_components/app-analytics.tsx` | 773 | apps | Analytics display; check for metric duplication |
| `voices/_components/voice-clone-form.tsx` | 767 | voices | Multi-tab form; candidate for form builder |
| `video/_components/video-page-client.tsx` | 765 | video | Video generation form |
| `earnings/_components/earnings-page-client.tsx` | 712 | earnings | Earnings display; check for chart duplication |
| `mcps/_components/mcps-section.tsx` | 683 | mcps | MCP configuration UI |
| `admin/_components/redemptions-client.tsx` | 675 | admin | Redemption management table |
| `apps/_components/platform-automation-card.tsx` | 671 | apps | Automation card UI |
| `account/_components/profile-form.tsx` | 664 | account | User profile form; candidate for form builder |
| `admin/Page.tsx` | 659 | admin | Main admin page; check for layout duplication |

---

**END OF REPORT**

Generated: 2026-05-12  
Analyzed by: Claude Code (read-only file search)

