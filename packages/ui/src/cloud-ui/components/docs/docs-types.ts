import type { ComponentType } from "react";

export type DocsFrontmatter = {
  title?: string;
  description?: string;
};

export type MdxModule = {
  default: ComponentType;
  frontmatter?: DocsFrontmatter;
};

export type NavItem =
  | { kind: "page"; slug: string; title: string; path: string }
  | { kind: "separator"; id: string; title: string }
  | {
      kind: "section";
      slug: string;
      title: string;
      path: string;
      children: NavItem[];
    };
