/**
 * Shared home glass recipe.
 *
 * Home owns one backdrop-filter budget: the pinned notification center. Ranked
 * widget cards must stay solid token tiles so every additional resident does
 * not add another compositing surface over the wallpaper.
 */
export const HOME_GLASS_CLASS =
  "mt-4 flex flex-col overflow-hidden rounded-2xl border border-white/55 bg-black/35 text-white backdrop-blur-md supports-[backdrop-filter]:bg-black/30";
