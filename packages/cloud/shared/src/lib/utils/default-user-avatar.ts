/**
 * Default user avatars for new account creation.
 * Served from Cloudflare R2 CDN (blob.elizacloud.ai).
 * Override the CDN base via NEXT_PUBLIC_ASSETS_CDN_URL.
 */

const DEFAULT_CDN_BASE = "https://blob.elizacloud.ai";

function cdnUrl(path: string): string {
  const base =
    (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_ASSETS_CDN_URL : undefined)?.trim() ||
    DEFAULT_CDN_BASE;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

const USER_AVATARS = [
  cdnUrl("cloud-avatars/profile-1.webp"),
  cdnUrl("cloud-avatars/profile-2.webp"),
  cdnUrl("cloud-avatars/profile-3.webp"),
  cdnUrl("cloud-avatars/profile-4.webp"),
  cdnUrl("cloud-avatars/profile-5.webp"),
  cdnUrl("cloud-avatars/profile-6.webp"),
  cdnUrl("cloud-avatars/profile-8.webp"),
  cdnUrl("cloud-avatars/profile-9.webp"),
  cdnUrl("cloud-avatars/profile-10.webp"),
  cdnUrl("cloud-avatars/profile-11.webp"),
  cdnUrl("cloud-avatars/profile-12.webp"),
  cdnUrl("cloud-avatars/profile-13.webp"),
  cdnUrl("cloud-avatars/profile-14.webp"),
  cdnUrl("cloud-avatars/profile-15.webp"),
  cdnUrl("cloud-avatars/profile-16.webp"),
  cdnUrl("cloud-avatars/profile-17.webp"),
  cdnUrl("cloud-avatars/profile-18.webp"),
  cdnUrl("cloud-avatars/profile-19.webp"),
  cdnUrl("cloud-avatars/profile-20.webp"),
  cdnUrl("cloud-avatars/profile-21.webp"),
  cdnUrl("cloud-avatars/profile-22.webp"),
  cdnUrl("cloud-avatars/profile-23.webp"),
  cdnUrl("cloud-avatars/profile-24.webp"),
  cdnUrl("cloud-avatars/profile-25.webp"),
  cdnUrl("cloud-avatars/profile-26.webp"),
  cdnUrl("cloud-avatars/profile-27.webp"),
  cdnUrl("cloud-avatars/profile-28.webp"),
  cdnUrl("cloud-avatars/profile-29.webp"),
  cdnUrl("cloud-avatars/profile-30.webp"),
  cdnUrl("cloud-avatars/profile-31.webp"),
  cdnUrl("cloud-avatars/profile-32.webp"),
  cdnUrl("cloud-avatars/profile-33.webp"),
  cdnUrl("cloud-avatars/profile-34.webp"),
  cdnUrl("cloud-avatars/profile-35.webp"),
  cdnUrl("cloud-avatars/profile-36.webp"),
];

export function getRandomUserAvatar(): string {
  const randomIndex = Math.floor(Math.random() * USER_AVATARS.length);
  return USER_AVATARS[randomIndex];
}
