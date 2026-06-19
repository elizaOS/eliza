/**
 * `ComputeProvider` — the provider-pluggable IaaS seam.
 *
 * This interface abstracts the infrastructure-as-a-service layer (server +
 * volume + action lifecycle + read-only catalog) used by the autoscaler and
 * the warm-pool scheduler to provision and decommission VPS nodes that join
 * the Docker pool. It is the *only* new per-provider code: the container
 * runtime (docker-over-SSH) is provider-agnostic and stays shared, so it is
 * deliberately NOT part of this interface.
 *
 * The shapes here (`ComputeServer`, `ComputeAction`, `ComputeVolume`) are the
 * minimal structural supertypes common to every provider. The Hetzner client
 * returns its richer `Hetzner*` shapes (numeric ids, provider-specific fields)
 * — those are structural subtypes of these, so `HetznerCloudClient implements
 * ComputeProvider` typechecks without widening any declared return type that
 * existing consumers (`node-autoscaler.ts`, `hetzner-volumes.ts`) depend on.
 *
 * `getComputeProvider()` selects the concrete provider from `COMPUTE_PROVIDER`
 * (default `hetzner`); `isComputeConfigured()` reports whether the selected
 * provider's elastic-provisioning surface is configured. Both are erased /
 * type-only at the seam: wiring the scheduler to call them is a later stage.
 */

import {
  getDigitalOceanComputeProvider,
  isDigitalOceanComputeConfigured,
} from "./digitalocean-provider";
import { getHetznerCloudClient, isHetznerCloudConfigured } from "./hetzner-cloud-api";

// ---------------------------------------------------------------------------
// Provider-agnostic shapes (structural supertypes of the Hetzner shapes)
// ---------------------------------------------------------------------------

/**
 * A provisioned compute server (VPS / droplet). Minimal common surface: an
 * identifier, a name, a lifecycle status, and (once booted) reachable IPs.
 * Provider clients may return richer subtypes with extra fields.
 */
export interface ComputeServer {
  /** Provider-native id (numeric on Hetzner, may differ per provider). */
  id: number | string;
  name: string;
  /** Coarse lifecycle status; provider-native status strings are a subtype. */
  status: string;
  /** ISO-8601 creation timestamp. */
  created?: string;
  /** Free-form provider labels. */
  labels?: Record<string, string>;
}

/**
 * An async provider action (create / attach / power) that completes out of
 * band. `waitForAction` polls one of these to terminal state.
 */
export interface ComputeAction {
  id: number | string;
  /** Provider-native action verb (e.g. `create_server`, `attach_volume`). */
  command?: string;
  /** Terminal states are everything other than `running`. */
  status: string;
  progress?: number;
  error?: { code: string; message: string } | null;
}

/**
 * A block-storage volume. `server` is the id of the server it is currently
 * attached to (null = unattached); `linuxDevice` is the in-VM device path
 * once attached.
 */
export interface ComputeVolume {
  id: number | string;
  name: string;
  /** Size in GiB. */
  size: number;
  /** Attached server id, or null when unattached. */
  server: number | string | null;
  status: string;
  labels?: Record<string, string>;
}

/**
 * The provider catalog entry for a server type / size (cores, memory, disk).
 */
export interface ComputeServerType {
  id: number | string;
  name: string;
}

/** A provider region / datacenter location. */
export interface ComputeLocation {
  id: number | string;
  name: string;
}

/** A provider OS image / snapshot. */
export interface ComputeImage {
  id: number | string;
  name: string | null;
}

// ---------------------------------------------------------------------------
// Inputs (canonical home — re-exported from hetzner-cloud-api for back-compat)
// ---------------------------------------------------------------------------

export interface CreateServerInput {
  name: string;
  serverType: string;
  /** Datacenter / location shorthand (e.g. "fsn1", "nbg1", "hel1", "ash"). */
  location: string;
  /** Image id or canonical name (e.g. "ubuntu-24.04"). */
  image: string;
  /**
   * Cloud-init / user_data script. Providers cap this (Hetzner: ≤32 KiB).
   * The default node bootstrap script is provided by
   * `buildContainerNodeUserData()`.
   */
  userData: string;
  /** SSH key IDs (numeric). The control plane's deploy key should be one. */
  sshKeyIds?: number[];
  /** Network IDs to attach the server to (private networking). */
  networkIds?: number[];
  /** Free-form provider label key/value map. */
  labels?: Record<string, string>;
}

export interface CreateVolumeInput {
  name: string;
  /** Volume size in GiB (providers allocate whole GiB). */
  sizeGb: number;
  /** Provider location code (must match the server it will attach to). */
  location: string;
  /** Filesystem format applied at creation time. Default `ext4`. */
  format?: "ext4" | "xfs";
  /** Optional server id to attach to immediately on create. */
  serverId?: number;
  /** Whether the provider should attempt automatic mount via cloud-init. */
  automount?: boolean;
  labels?: Record<string, string>;
}

/**
 * Result of `createServer`. Generic over the concrete server shape so a
 * provider client can return its richer subtype (e.g. `HetznerServer`) without
 * widening — consumers reading provider-specific fields keep compiling.
 */
export interface ProvisionedServer<S extends ComputeServer = ComputeServer> {
  server: S;
  /** Root password if the provider returns one on create, else null. */
  rootPassword: string | null;
}

// ---------------------------------------------------------------------------
// ComputeProvider interface
// ---------------------------------------------------------------------------

/**
 * The IaaS seam. Declared with method syntax (not arrow properties) so method
 * parameters are bivariant — a provider client whose ids are `number` (Hetzner)
 * satisfies the generic `number | string` parameter without `strictFunctionTypes`
 * rejecting it.
 *
 * Return types use the bare `Compute*` defaults; a provider client may declare
 * richer subtypes (returns are covariant under `implements`).
 */
export interface ComputeProvider {
  // -- Server lifecycle ----------------------------------------------------
  listServers(labels?: Record<string, string>): Promise<ComputeServer[]>;
  getServer(id: number): Promise<ComputeServer | null>;
  /** Returns before the server is ready; poll `getServer`/`waitForAction`. */
  createServer(input: CreateServerInput): Promise<ProvisionedServer>;
  /** Provider 404 on delete is treated as success by consumers. */
  deleteServer(id: number): Promise<void>;
  powerOff(id: number): Promise<ComputeAction>;
  powerOn(id: number): Promise<ComputeAction>;

  // -- Block storage -------------------------------------------------------
  listVolumes(filter?: {
    label?: Record<string, string>;
    location?: string;
  }): Promise<ComputeVolume[]>;
  getVolume(id: number): Promise<ComputeVolume | null>;
  createVolume(input: CreateVolumeInput): Promise<ComputeVolume>;
  /** Online attach, no reboot. */
  attachVolume(volumeId: number, serverId: number): Promise<ComputeAction>;
  detachVolume(volumeId: number): Promise<ComputeAction>;
  deleteVolume(id: number): Promise<void>;

  // -- The load-bearing async primitive ------------------------------------
  waitForAction(actionId: number, timeoutMs?: number): Promise<ComputeAction>;

  // -- Catalog (read-only) -------------------------------------------------
  listServerTypes(): Promise<ComputeServerType[]>;
  listLocations(): Promise<ComputeLocation[]>;
  listImages(filter?: { type?: string; architecture?: "x86" | "arm" }): Promise<ComputeImage[]>;
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export type ComputeProviderName = "hetzner" | "digitalocean";

/**
 * Resolve the configured provider name from `COMPUTE_PROVIDER`. DigitalOcean is
 * selected ONLY for the explicit value `digitalocean`; everything else (unset,
 * empty, or any other value) defaults to `hetzner` so runtime is unchanged.
 */
function resolveComputeProviderName(): ComputeProviderName {
  return process.env.COMPUTE_PROVIDER === "digitalocean" ? "digitalocean" : "hetzner";
}

/**
 * Select the concrete `ComputeProvider`. Defaults to the existing Hetzner
 * client so runtime behavior is unchanged; `digitalocean` selects the in-tree
 * `DigitalOceanComputeProvider`.
 *
 * Both provider imports are normal ESM value imports. `hetzner-cloud-api` and
 * `digitalocean-provider` only import *types* from this module, so there is no
 * runtime initialization cycle (type-only imports are erased).
 */
export function getComputeProvider(): ComputeProvider {
  const provider = resolveComputeProviderName();
  if (provider === "digitalocean") {
    return getDigitalOceanComputeProvider();
  }
  // Hetzner (default).
  return getHetznerCloudClient();
}

/** Whether the selected provider's elastic-provisioning surface is configured. */
export function isComputeConfigured(): boolean {
  const provider = resolveComputeProviderName();
  if (provider === "digitalocean") {
    return isDigitalOceanComputeConfigured();
  }
  return isHetznerCloudConfigured();
}
