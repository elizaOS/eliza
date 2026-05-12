/**
 * Default user avatars for new account creation.
 * These avatars are assigned randomly when a user creates their first account.
 */

const USER_AVATARS = [
  "/cloud-avatars/profile-1.webp",
  "/cloud-avatars/profile-2.webp",
  "/cloud-avatars/profile-3.webp",
  "/cloud-avatars/profile-4.webp",
  "/cloud-avatars/profile-5.webp",
  "/cloud-avatars/profile-6.webp",
  "/cloud-avatars/profile-8.webp",
  "/cloud-avatars/profile-9.webp",
  "/cloud-avatars/profile-10.webp",
  "/cloud-avatars/profile-11.webp",
  "/cloud-avatars/profile-12.webp",
  "/cloud-avatars/profile-13.webp",
  "/cloud-avatars/profile-14.webp",
  "/cloud-avatars/profile-15.webp",
  "/cloud-avatars/profile-16.webp",
  "/cloud-avatars/profile-17.webp",
  "/cloud-avatars/profile-18.webp",
  "/cloud-avatars/profile-19.webp",
  "/cloud-avatars/profile-20.webp",
  "/cloud-avatars/profile-21.webp",
  "/cloud-avatars/profile-22.webp",
  "/cloud-avatars/profile-23.webp",
  "/cloud-avatars/profile-24.webp",
  "/cloud-avatars/profile-25.webp",
  "/cloud-avatars/profile-26.webp",
  "/cloud-avatars/profile-27.webp",
  "/cloud-avatars/profile-28.webp",
  "/cloud-avatars/profile-29.webp",
  "/cloud-avatars/profile-30.webp",
  "/cloud-avatars/profile-31.webp",
  "/cloud-avatars/profile-32.webp",
  "/cloud-avatars/profile-33.webp",
  "/cloud-avatars/profile-34.webp",
  "/cloud-avatars/profile-35.webp",
  "/cloud-avatars/profile-36.webp",
] as const;

export function getRandomUserAvatar(): string {
  const randomIndex = Math.floor(Math.random() * USER_AVATARS.length);
  return USER_AVATARS[randomIndex];
}
