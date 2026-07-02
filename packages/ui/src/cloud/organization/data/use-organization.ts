/**
 * React-Query data hooks for the Organization settings surface.
 *
 * Ported from the cloud-frontend organization tab, which used raw `fetch()` +
 * manual `useState`/`useEffect` loading and component-local refetch. Here the
 * reads/writes go through the shared typed {@link api} client and React-Query,
 * so mutations invalidate the relevant query instead of re-running ad-hoc
 * fetchers.
 *
 * Endpoints (note plural `organizations`, no `/v1`):
 * - `GET    /api/v1/user`                          current user + organization
 * - `GET    /api/organizations/members`            list members (owner/admin)
 * - `GET    /api/organizations/invites`            list invites (owner/admin)
 * - `POST   /api/organizations/invites`            create invite (owner/admin)
 * - `DELETE /api/organizations/invites/:inviteId`  revoke invite (owner/admin)
 * - `PATCH  /api/organizations/members/:userId`    update role (owner)
 * - `DELETE /api/organizations/members/:userId`    remove member (owner/admin)
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../lib/api-client";
import type {
  CreatedInviteDto,
  InviteRole,
  OrgInviteDto,
  OrgMemberDto,
  UserWithOrganizationDto,
} from "./cloud-org-types";

interface Envelope<T> {
  success?: boolean;
  data: T;
  error?: string;
}

export const organizationQueryKeys = {
  user: ["cloud", "organization", "user"] as const,
  members: ["cloud", "organization", "members"] as const,
  invites: ["cloud", "organization", "invites"] as const,
};

/** Current user (with organization) used to scope the org surface + RBAC. */
export function useOrganizationUser() {
  return useQuery<UserWithOrganizationDto>({
    queryKey: organizationQueryKeys.user,
    queryFn: async () => {
      const res = await api<Envelope<UserWithOrganizationDto>>("/api/v1/user");
      return res.data;
    },
  });
}

/** Organization members. Backend gates this to owner/admin (403 otherwise). */
export function useOrganizationMembers(enabled: boolean) {
  return useQuery<OrgMemberDto[]>({
    queryKey: organizationQueryKeys.members,
    enabled,
    queryFn: async () => {
      const res = await api<Envelope<OrgMemberDto[]>>(
        "/api/organizations/members",
      );
      return res.data;
    },
  });
}

/** Pending + historical invites. Backend gates this to owner/admin. */
export function useOrganizationInvites(enabled: boolean) {
  return useQuery<OrgInviteDto[]>({
    queryKey: organizationQueryKeys.invites,
    enabled,
    queryFn: async () => {
      const res = await api<Envelope<OrgInviteDto[]>>(
        "/api/organizations/invites",
      );
      return res.data;
    },
  });
}

/** Translate an {@link ApiError} into the human message the API put in `error`. */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { email: string; role: InviteRole }) => {
      // `data.token` is the raw invite token, returned exactly once at
      // creation so the inviter can copy a shareable accept link.
      const res = await api<Envelope<CreatedInviteDto>>(
        "/api/organizations/invites",
        {
          method: "POST",
          json: input,
        },
      );
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: organizationQueryKeys.invites,
      });
    },
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (inviteId: string) => {
      await api(`/api/organizations/invites/${inviteId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: organizationQueryKeys.invites,
      });
    },
  });
}

export function useUpdateMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; role: InviteRole }) => {
      await api(`/api/organizations/members/${input.userId}`, {
        method: "PATCH",
        json: { role: input.role },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: organizationQueryKeys.members,
      });
    },
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await api(`/api/organizations/members/${userId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: organizationQueryKeys.members,
      });
    },
  });
}

export { messageOf as organizationErrorMessage };
