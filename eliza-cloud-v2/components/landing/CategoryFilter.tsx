"use client";

import { useRouter, useSearchParams } from "next/navigation";

interface CategoryFilterProps {
  categories: string[];
}

export default function CategoryFilter({ categories }: CategoryFilterProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeCategory = searchParams.get("category");

  const handleCategoryChange = (category: string | null) => {
    if (category) {
      router.push(`/blog?category=${category}`, { scroll: false });
    } else {
      router.push("/blog", { scroll: false });
    }
  };

  return (
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
      <button
        onClick={() => handleCategoryChange(null)}
        className={`rounded-full px-4 py-2 text-center text-sm font-medium transition-all sm:py-1.5 ${
          !activeCategory
            ? "bg-orange-500 text-white"
            : "bg-white/10 text-neutral-300 hover:bg-white/20"
        }`}
      >
        All
      </button>
      {categories.map((category) => (
        <button
          key={category}
          onClick={() => handleCategoryChange(category)}
          className={`rounded-full px-4 py-2 text-center text-sm font-medium capitalize transition-all sm:py-1.5 ${
            activeCategory === category
              ? "bg-orange-500 text-white"
              : "bg-white/10 text-neutral-300 hover:bg-white/20"
          }`}
        >
          {category}
        </button>
      ))}
    </div>
  );
}
