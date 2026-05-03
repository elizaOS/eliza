"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { steward } from "@/lib/api";
import type { RouteCreatePayload, RouteRecord, SecretRecord } from "@/lib/steward-client";
import { formatDate } from "@/lib/utils";

const ease: [number, number, number, number] = [0.25, 1, 0.5, 1];

interface Toast {
  id: string;
  message: string;
  kind: "success" | "error";
}

const INJECT_OPTIONS: {
  value: RouteCreatePayload["injectAs"];
  label: string;
}[] = [
  { value: "header", label: "HTTP Header" },
  { value: "query", label: "Query Param" },
  { value: "body", label: "Request Body" },
];

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    name: "",
    value: "",
    description: "",
  });

  // Detail / selected secret
  const [selected, setSelected] = useState<SecretRecord | null>(null);

  // Routes for selected secret
  const [routes, setRoutes] = useState<RouteRecord[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [showAddRoute, setShowAddRoute] = useState(false);
  const [addingRoute, setAddingRoute] = useState(false);
  const [routeForm, setRouteForm] = useState<Omit<RouteCreatePayload, "secretId">>({
    hostPattern: "",
    pathPattern: "",
    injectAs: "header",
    headerName: "",
    queryParam: "",
    bodyPath: "",
  });

  // Rotate
  const [showRotate, setShowRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateValue, setRotateValue] = useState("");

  // Delete
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function toast(message: string, kind: Toast["kind"]) {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((p) => [...p, { id, message, kind }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3500);
  }

  async function loadSecrets() {
    try {
      setLoading(true);
      setError(null);
      const list = await steward.listSecrets();
      setSecrets(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load secrets");
    } finally {
      setLoading(false);
    }
  }

  const loadRoutes = useCallback(async (secretId: string) => {
    setRoutesLoading(true);
    try {
      const list = await steward.listRoutes(secretId);
      setRoutes(list);
    } catch {
      setRoutes([]);
    } finally {
      setRoutesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSecrets();
  }, [loadSecrets]);

  useEffect(() => {
    if (selected) loadRoutes(selected.id);
    else setRoutes([]);
  }, [selected, loadRoutes]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.name || !createForm.value) return;
    setCreating(true);
    setCreateError(null);
    try {
      const s = await steward.createSecret({
        name: createForm.name,
        value: createForm.value,
        description: createForm.description || undefined,
      });
      setSecrets((p) => [s, ...p]);
      setShowCreate(false);
      setCreateForm({ name: "", value: "", description: "" });
      toast("Secret created", "success");
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Failed to create secret");
    } finally {
      setCreating(false);
    }
  }

  async function handleRotate(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !rotateValue) return;
    setRotating(true);
    try {
      const updated = await steward.rotateSecret(selected.id, {
        value: rotateValue,
      });
      setSecrets((p) => p.map((s) => (s.id === updated.id ? updated : s)));
      setSelected(updated);
      setShowRotate(false);
      setRotateValue("");
      toast(`Secret rotated to version ${updated.version}`, "success");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Failed to rotate secret", "error");
    } finally {
      setRotating(false);
    }
  }

  async function handleDelete(secretId: string) {
    setDeleting(true);
    try {
      await steward.deleteSecret(secretId);
      setSecrets((p) => p.filter((s) => s.id !== secretId));
      if (selected?.id === secretId) setSelected(null);
      setConfirmDelete(null);
      toast("Secret deleted", "success");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Failed to delete secret", "error");
    } finally {
      setDeleting(false);
    }
  }

  async function handleAddRoute(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !routeForm.hostPattern) return;
    setAddingRoute(true);
    try {
      const route = await steward.createRoute({
        ...routeForm,
        secretId: selected.id,
      });
      setRoutes((p) => [...p, route]);
      setShowAddRoute(false);
      setRouteForm({
        hostPattern: "",
        pathPattern: "",
        injectAs: "header",
        headerName: "",
        queryParam: "",
        bodyPath: "",
      });
      toast("Route added", "success");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Failed to add route", "error");
    } finally {
      setAddingRoute(false);
    }
  }

  async function handleDeleteRoute(routeId: string) {
    try {
      await steward.deleteRoute(routeId);
      setRoutes((p) => p.filter((r) => r.id !== routeId));
      toast("Route removed", "success");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Failed to remove route", "error");
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-8"
    >
      {/* Toast */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              transition={{ duration: 0.22, ease }}
              className={`px-4 py-3 text-sm font-medium border pointer-events-auto ${
                t.kind === "success"
                  ? "bg-bg-elevated border-emerald-400/30 text-emerald-400"
                  : "bg-bg-elevated border-red-400/30 text-red-400"
              }`}
            >
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-700 tracking-tight">Secrets</h1>
          <p className="text-sm text-text-tertiary mt-1">
            Manage API keys and credentials injected into agent requests
          </p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors font-medium"
        >
          New Secret
        </button>
      </div>

      {/* Create form */}
      <AnimatePresence>
        {showCreate && (
          <motion.form
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease }}
            onSubmit={handleCreate}
            className="overflow-hidden"
          >
            <div className="border border-border bg-bg-elevated p-6 space-y-5">
              <h3 className="font-display text-sm font-600">Create Secret</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-text-tertiary block mb-1.5">
                    Name <span className="text-accent">*</span>
                  </label>
                  <input
                    type="text"
                    value={createForm.name}
                    onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                    placeholder="openai-api-key"
                    className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-tertiary block mb-1.5">Description</label>
                  <input
                    type="text"
                    value={createForm.description}
                    onChange={(e) =>
                      setCreateForm({
                        ...createForm,
                        description: e.target.value,
                      })
                    }
                    placeholder="OpenAI key for GPT-4 calls"
                    className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-text-tertiary block mb-1.5">
                  Secret Value <span className="text-accent">*</span>
                </label>
                <input
                  type="password"
                  value={createForm.value}
                  onChange={(e) => setCreateForm({ ...createForm, value: e.target.value })}
                  placeholder="sk-..."
                  className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                />
                <p className="text-xs text-text-tertiary mt-1.5">
                  Value is encrypted at rest and never returned in plaintext after creation.
                </p>
              </div>
              <AnimatePresence>
                {createError && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="text-xs text-red-400 font-mono"
                  >
                    {createError}
                  </motion.p>
                )}
              </AnimatePresence>
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={creating || !createForm.name || !createForm.value}
                  className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  {creating ? "Creating..." : "Create"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCreate(false);
                    setCreateError(null);
                  }}
                  className="px-4 py-2 text-sm text-text-tertiary hover:text-text transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Error */}
      {error && !loading && (
        <div className="py-16 text-center border border-red-400/20 bg-red-400/5">
          <p className="text-text-secondary text-sm mb-1">Failed to load secrets</p>
          <p className="text-text-tertiary text-xs mb-4 font-mono">{error}</p>
          <button
            onClick={loadSecrets}
            className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Main content: list + detail side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Secrets list */}
        <div className="lg:col-span-2">
          {loading ? (
            <div className="space-y-px bg-border">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="bg-bg h-16 animate-pulse" />
              ))}
            </div>
          ) : secrets.length === 0 && !error ? (
            <div className="py-16 text-center border border-border-subtle">
              <p className="font-display text-base font-600 text-text-secondary">No secrets yet</p>
              <p className="text-sm text-text-tertiary mt-1 max-w-xs mx-auto">
                Store API keys and credentials that agents can use in their requests.
              </p>
              <button
                onClick={() => setShowCreate(true)}
                className="mt-4 px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
              >
                Create First Secret
              </button>
            </div>
          ) : (
            <div className="border-t border-border-subtle">
              <AnimatePresence initial={false}>
                {secrets.map((secret) => (
                  <motion.button
                    key={secret.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease }}
                    onClick={() => setSelected(selected?.id === secret.id ? null : secret)}
                    className={`w-full text-left flex items-center justify-between py-4 px-3 border-b border-border-subtle transition-colors group ${
                      selected?.id === secret.id ? "bg-accent-bg" : "hover:bg-bg-elevated/40"
                    }`}
                  >
                    <div className="min-w-0">
                      <div
                        className={`font-display font-600 text-sm truncate ${selected?.id === secret.id ? "text-accent" : "group-hover:text-accent transition-colors"}`}
                      >
                        {secret.name}
                      </div>
                      <div className="text-xs text-text-tertiary mt-0.5 truncate">
                        {secret.description || "No description"}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                      <span className="text-xs font-mono text-text-tertiary">
                        v{secret.version}
                      </span>
                      {secret.routeCount > 0 && (
                        <span className="text-xs px-1.5 py-0.5 bg-accent-bg text-[oklch(0.75_0.15_55)] font-medium">
                          {secret.routeCount} route
                          {secret.routeCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-3">
          <AnimatePresence mode="wait">
            {selected ? (
              <motion.div
                key={selected.id}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.25, ease }}
                className="border border-border bg-bg-elevated space-y-6 p-6"
              >
                {/* Secret header */}
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-display text-lg font-700">{selected.name}</h2>
                    {selected.description && (
                      <p className="text-sm text-text-tertiary mt-0.5">{selected.description}</p>
                    )}
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    className="text-text-tertiary hover:text-text transition-colors text-lg leading-none"
                  >
                    &times;
                  </button>
                </div>

                {/* Metadata */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: "Version", value: `v${selected.version}` },
                    { label: "Routes", value: String(selected.routeCount) },
                    { label: "Created", value: formatDate(selected.createdAt) },
                    { label: "Updated", value: formatDate(selected.updatedAt) },
                  ].map(({ label, value }) => (
                    <div key={label} className="space-y-1">
                      <div className="text-xs text-text-tertiary">{label}</div>
                      <div className="text-sm font-mono tabular-nums text-text-secondary">
                        {value}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Encrypted value indicator */}
                <div className="flex items-center gap-2 px-3 py-2 border border-border-subtle bg-bg text-xs text-text-tertiary">
                  <span className="text-amber-400">&#9679;</span>
                  <span>Value encrypted at rest. Use rotation to update.</span>
                </div>

                {/* Actions */}
                <div className="flex gap-3 flex-wrap">
                  <button
                    onClick={() => setShowRotate(!showRotate)}
                    className="px-4 py-2 text-xs font-medium border border-border text-text-secondary hover:border-accent hover:text-accent transition-colors"
                  >
                    Rotate Secret
                  </button>
                  <button
                    onClick={() => setConfirmDelete(selected.id)}
                    className="px-4 py-2 text-xs font-medium border border-red-400/20 text-red-400 hover:bg-red-400/10 transition-colors"
                  >
                    Delete
                  </button>
                </div>

                {/* Rotate form */}
                <AnimatePresence>
                  {showRotate && (
                    <motion.form
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease }}
                      onSubmit={handleRotate}
                      className="overflow-hidden"
                    >
                      <div className="border border-amber-400/20 bg-amber-400/5 p-4 space-y-3">
                        <p className="text-xs text-amber-400 font-medium">
                          Rotation creates a new version. Previous version is immediately
                          invalidated.
                        </p>
                        <input
                          type="password"
                          value={rotateValue}
                          onChange={(e) => setRotateValue(e.target.value)}
                          placeholder="New secret value..."
                          className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                        />
                        <div className="flex gap-3">
                          <button
                            type="submit"
                            disabled={rotating || !rotateValue}
                            className="px-4 py-2 text-xs font-medium bg-amber-400/20 text-amber-400 hover:bg-amber-400/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {rotating ? "Rotating..." : "Confirm Rotation"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowRotate(false);
                              setRotateValue("");
                            }}
                            className="px-3 py-2 text-xs text-text-tertiary hover:text-text transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </motion.form>
                  )}
                </AnimatePresence>

                {/* Delete confirm */}
                <AnimatePresence>
                  {confirmDelete === selected.id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease }}
                      className="overflow-hidden"
                    >
                      <div className="border border-red-400/20 bg-red-400/5 p-4 space-y-3">
                        <p className="text-xs text-red-400 font-medium">
                          Delete "{selected.name}"? This cannot be undone. Any routes using this
                          secret will stop working.
                        </p>
                        <div className="flex gap-3">
                          <button
                            onClick={() => handleDelete(selected.id)}
                            disabled={deleting}
                            className="px-4 py-2 text-xs font-medium bg-red-400/20 text-red-400 hover:bg-red-400/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {deleting ? "Deleting..." : "Delete Secret"}
                          </button>
                          <button
                            onClick={() => setConfirmDelete(null)}
                            className="px-3 py-2 text-xs text-text-tertiary hover:text-text transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Divider */}
                <div className="border-t border-border-subtle pt-4">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-display text-sm font-600">Route Configuration</h3>
                    <button
                      onClick={() => setShowAddRoute(!showAddRoute)}
                      className="text-xs px-3 py-1.5 border border-border text-text-tertiary hover:text-text hover:border-accent transition-colors"
                    >
                      + Add Route
                    </button>
                  </div>

                  {/* Add route form */}
                  <AnimatePresence>
                    {showAddRoute && (
                      <motion.form
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2, ease }}
                        onSubmit={handleAddRoute}
                        className="overflow-hidden mb-4"
                      >
                        <div className="border border-border bg-bg p-4 space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="text-xs text-text-tertiary block mb-1">
                                Host Pattern <span className="text-accent">*</span>
                              </label>
                              <input
                                type="text"
                                value={routeForm.hostPattern}
                                onChange={(e) =>
                                  setRouteForm({
                                    ...routeForm,
                                    hostPattern: e.target.value,
                                  })
                                }
                                placeholder="api.openai.com"
                                className="w-full bg-bg-elevated border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-text-tertiary block mb-1">
                                Path Pattern
                              </label>
                              <input
                                type="text"
                                value={routeForm.pathPattern}
                                onChange={(e) =>
                                  setRouteForm({
                                    ...routeForm,
                                    pathPattern: e.target.value,
                                  })
                                }
                                placeholder="/v1/*"
                                className="w-full bg-bg-elevated border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                              />
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <label className="text-xs text-text-tertiary block mb-1">
                                Inject As
                              </label>
                              <select
                                value={routeForm.injectAs}
                                onChange={(e) =>
                                  setRouteForm({
                                    ...routeForm,
                                    injectAs: e.target.value as RouteCreatePayload["injectAs"],
                                  })
                                }
                                className="w-full bg-bg-elevated border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-accent transition-colors"
                              >
                                {INJECT_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {routeForm.injectAs === "header" && (
                              <div>
                                <label className="text-xs text-text-tertiary block mb-1">
                                  Header Name
                                </label>
                                <input
                                  type="text"
                                  value={routeForm.headerName}
                                  onChange={(e) =>
                                    setRouteForm({
                                      ...routeForm,
                                      headerName: e.target.value,
                                    })
                                  }
                                  placeholder="Authorization"
                                  className="w-full bg-bg-elevated border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                                />
                              </div>
                            )}
                            {routeForm.injectAs === "query" && (
                              <div>
                                <label className="text-xs text-text-tertiary block mb-1">
                                  Query Param
                                </label>
                                <input
                                  type="text"
                                  value={routeForm.queryParam}
                                  onChange={(e) =>
                                    setRouteForm({
                                      ...routeForm,
                                      queryParam: e.target.value,
                                    })
                                  }
                                  placeholder="api_key"
                                  className="w-full bg-bg-elevated border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                                />
                              </div>
                            )}
                            {routeForm.injectAs === "body" && (
                              <div>
                                <label className="text-xs text-text-tertiary block mb-1">
                                  Body Path
                                </label>
                                <input
                                  type="text"
                                  value={routeForm.bodyPath}
                                  onChange={(e) =>
                                    setRouteForm({
                                      ...routeForm,
                                      bodyPath: e.target.value,
                                    })
                                  }
                                  placeholder="auth.token"
                                  className="w-full bg-bg-elevated border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                                />
                              </div>
                            )}
                          </div>
                          <div className="flex gap-3">
                            <button
                              type="submit"
                              disabled={addingRoute || !routeForm.hostPattern}
                              className="px-4 py-2 text-xs font-medium bg-accent text-bg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {addingRoute ? "Adding..." : "Add Route"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setShowAddRoute(false)}
                              className="px-3 py-2 text-xs text-text-tertiary hover:text-text transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </motion.form>
                    )}
                  </AnimatePresence>

                  {/* Routes list */}
                  {routesLoading ? (
                    <div className="space-y-px">
                      {[...Array(2)].map((_, i) => (
                        <div key={i} className="bg-bg h-12 animate-pulse" />
                      ))}
                    </div>
                  ) : routes.length === 0 ? (
                    <div className="py-8 text-center border border-border-subtle">
                      <p className="text-xs text-text-tertiary">
                        No routes configured. Routes define where this secret gets injected.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {routes.map((route) => (
                        <div
                          key={route.id}
                          className="flex items-center justify-between py-3 px-3 border border-border-subtle hover:bg-bg-surface/30 transition-colors"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="font-mono text-xs text-text truncate">
                              {route.hostPattern}
                              {route.pathPattern && (
                                <span className="text-text-tertiary">{route.pathPattern}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-text-tertiary">
                              <span className="px-1.5 py-0.5 bg-bg text-text-tertiary border border-border-subtle">
                                {route.injectAs}
                              </span>
                              {route.headerName && (
                                <span className="font-mono">{route.headerName}</span>
                              )}
                              {route.queryParam && (
                                <span className="font-mono">?{route.queryParam}</span>
                              )}
                              {route.bodyPath && (
                                <span className="font-mono">.{route.bodyPath}</span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteRoute(route.id)}
                            className="ml-3 text-xs text-text-tertiary hover:text-red-400 transition-colors flex-shrink-0"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-40 border border-border-subtle flex items-center justify-center"
              >
                <p className="text-sm text-text-tertiary">Select a secret to view details</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
