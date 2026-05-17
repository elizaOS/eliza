"use client";

import { memo } from "react";
import { cn } from "../../lib/utils";
import Image from "../../runtime/image";

const DEFAULT_CDN_BASE = "https://blob.elizacloud.ai";
const DEFAULT_AVATAR = "/avatars/eliza.png";

function cdnUrl(path: string): string {
  const base =
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_ASSETS_CDN_URL
      : undefined
    )?.trim() || DEFAULT_CDN_BASE;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

const CLOUD_AGENT_AVATARS = [
  cdnUrl("cloud-agent-samples/2ab55b3c-25a1-4b5b-b548-045c361819e6.webp"),
  cdnUrl("cloud-agent-samples/2b1a6c3f-bdb8-4e67-b843-87833df422cd.webp"),
  cdnUrl("cloud-agent-samples/2bf035d3-d153-446a-ba15-9f87c4b8676f.webp"),
  cdnUrl("cloud-agent-samples/2d03e431-df85-4749-83f8-b68c43b786df.webp"),
  cdnUrl("cloud-agent-samples/2e41cb7a-811f-4e42-9865-ff95730d655f.webp"),
  cdnUrl("cloud-agent-samples/4a4f1148-a899-4286-bd51-1b0177d93e21.webp"),
  cdnUrl("cloud-agent-samples/4c59f69d-fe4e-4b88-bdac-fa0f5bd38934.webp"),
  cdnUrl("cloud-agent-samples/7ac0ef82-857f-4c71-9d13-d5e85ea64ca5.webp"),
  cdnUrl("cloud-agent-samples/8c9f3acc-47e5-4d2d-b059-286bac99e561.webp"),
  cdnUrl("cloud-agent-samples/08df48b4-3ee1-4593-9f13-fd11b9677378.webp"),
  cdnUrl("cloud-agent-samples/9a916762-6a48-4435-85d2-9fad525dfc5e.webp"),
  cdnUrl("cloud-agent-samples/9eb9d66d-9955-488f-baf2-76f5e50f93c7.webp"),
  cdnUrl("cloud-agent-samples/20beea15-3e44-4eca-a1db-f5c05e9f562d.webp"),
  cdnUrl("cloud-agent-samples/31bfcf9e-70f6-4e19-bced-bda6e24171c0.webp"),
  cdnUrl("cloud-agent-samples/73b9235f-9ff4-42de-a12f-0b018e4ec251.webp"),
  cdnUrl("cloud-agent-samples/74ac181f-00f2-49c1-872d-1b480d481bfc.webp"),
  cdnUrl("cloud-agent-samples/902d3591-d5ab-4b65-9344-2e7738d47ffc.webp"),
  cdnUrl("cloud-agent-samples/7704fd9d-e3e2-43ac-a5fa-9b5e43d373ed.webp"),
  cdnUrl("cloud-agent-samples/8509dafc-2bc8-4eb9-8e7a-38602cd3eb48.webp"),
  cdnUrl("cloud-agent-samples/78638d61-2c9c-410e-a396-cd21be9c0700.webp"),
  cdnUrl("cloud-agent-samples/484341c3-736a-4f15-93ba-fec779a7268e.webp"),
  cdnUrl("cloud-agent-samples/817925f5-ef58-4222-81ab-d98027e66094.webp"),
  cdnUrl("cloud-agent-samples/35697829-87cb-451e-a0cb-0f7a26c9b729.webp"),
  cdnUrl("cloud-agent-samples/a3a3d8bb-4510-44b3-b1c5-00055c25c160.webp"),
  cdnUrl("cloud-agent-samples/a7eba0a6-14bc-4fe5-b5d0-792925c2852c.webp"),
  cdnUrl("cloud-agent-samples/a99ecf03-26f8-4d50-8762-237d419ea1f2.webp"),
  cdnUrl("cloud-agent-samples/a8097634-c950-48ad-8bec-b08a810251b6_1.webp"),
  cdnUrl("cloud-agent-samples/aa6c7257-7962-439c-802d-a592be96b79c.webp"),
  cdnUrl("cloud-agent-samples/abc8888f-0854-4469-8b00-98cc879f87ba.webp"),
  cdnUrl("cloud-agent-samples/aeb157ed-3744-47eb-aa25-3c2e057af199.webp"),
  cdnUrl("cloud-agent-samples/b237d37b-73b2-488a-903d-1e6a06c1ea92.webp"),
  cdnUrl("cloud-agent-samples/b364f77c-599b-4dd9-ba19-e20a94b6bf3f.webp"),
  cdnUrl("cloud-agent-samples/b639a5c9-1cd3-4cbc-a4c5-921ca3c120b5.webp"),
  cdnUrl("cloud-agent-samples/beccf811-b6d9-4409-b936-36a35b9bc417.webp"),
  cdnUrl("cloud-agent-samples/c20b47af-2075-4c1b-8b32-8b756dea2989.webp"),
  cdnUrl("cloud-agent-samples/c63e72cd-6e99-4ce1-b0fe-a363f3121c5f.webp"),
  cdnUrl("cloud-agent-samples/cccf4c27-47fa-42f7-b00d-27ebe6fb42b8.webp"),
  cdnUrl("cloud-agent-samples/ce3e89ac-6376-4b96-b260-e2ac2f16e1dd.webp"),
  cdnUrl("cloud-agent-samples/d30bc02f-d21c-4105-b8be-cd5f44a7cf24.webp"),
  cdnUrl("cloud-agent-samples/d39c4a72-e294-453a-982f-12e6061c2f7e.webp"),
  cdnUrl("cloud-agent-samples/d2681e5d-2a8b-4498-9cf8-323b5c86a809.webp"),
  cdnUrl("cloud-agent-samples/ecf07f41-33d0-48c0-bbfd-e5a484c726b8.webp"),
  cdnUrl("cloud-agent-samples/ef67d566-87c5-4608-9700-032a6c6c8bae.webp"),
  cdnUrl("cloud-agent-samples/efb63574-2949-4b28-9187-ae76b1ce1be8.webp"),
  cdnUrl("cloud-agent-samples/fb36ddbc-b8be-43fb-9da7-71381e410010.webp"),
  cdnUrl("cloud-agent-samples/fee4baa8-6166-4a77-9b41-812a8b489354.webp"),
];

const ALL_AVATARS = [
  ...CLOUD_AGENT_AVATARS,
  "/avatars/eliza.png",
  "/avatars/amara.webp",
  "/avatars/luna.webp",
  "/avatars/prof_ada.webp",
  "/avatars/voiceai.webp",
  "/avatars/wellnesscoach.webp",
  "/avatars/edad.webp",
];

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function ensureAvatarUrl(avatarUrl: string | null | undefined, name?: string) {
  if (avatarUrl && avatarUrl.trim() !== "") {
    return avatarUrl;
  }
  if (name) {
    return CLOUD_AGENT_AVATARS[simpleHash(name) % CLOUD_AGENT_AVATARS.length];
  }
  return DEFAULT_AVATAR;
}

function isBuiltInAvatar(url: string | null | undefined): boolean {
  if (!url) return false;
  const cdnBase =
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_ASSETS_CDN_URL
      : undefined
    )?.trim() || DEFAULT_CDN_BASE;
  return (
    url.startsWith("/avatars/") ||
    url.startsWith(cdnBase) ||
    ALL_AVATARS.some((avatar) => avatar === url)
  );
}

export interface ElizaAvatarProps {
  avatarUrl?: string | null;
  name?: string;
  className?: string;
  fallbackClassName?: string;
  iconClassName?: string;
  animate?: boolean;
  priority?: boolean;
}

export const ElizaAvatar = memo(function ElizaAvatar({
  avatarUrl,
  name = "Eliza",
  className,
  iconClassName,
  animate = false,
  priority = false,
}: ElizaAvatarProps) {
  const resolvedAvatarUrl = ensureAvatarUrl(avatarUrl, name);

  return (
    <div
      className={cn(
        "relative flex shrink-0 overflow-hidden rounded-full",
        className,
      )}
    >
      <Image
        key={resolvedAvatarUrl}
        src={resolvedAvatarUrl}
        alt={name}
        fill
        className={cn(
          "object-cover",
          animate ? "animate-pulse" : "",
          iconClassName,
        )}
        sizes="48px"
        priority={priority}
        unoptimized={!isBuiltInAvatar(resolvedAvatarUrl)}
      />
    </div>
  );
});
