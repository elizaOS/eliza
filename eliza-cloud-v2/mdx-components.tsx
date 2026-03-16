import { useMDXComponents as getDocsMDXComponents } from "nextra-theme-docs";
import Tweet from "@/components/landing/Tweet";

const docsComponents = getDocsMDXComponents();

export function useMDXComponents(
  components?: Record<string, React.ComponentType>,
) {
  return {
    ...docsComponents,
    Tweet,
    ...components,
  };
}
