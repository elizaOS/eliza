/**
 * Agents Layout Component
 *
 * @description Simple layout component for the agents section that directly renders
 * its children. Configured for dynamic rendering with no revalidation.
 *
 * @param {Object} props - Component props
 * @param {React.ReactNode} props.children - Child components to render
 *
 * @returns {JSX.Element} Layout wrapper
 */
export const dynamic = "force-dynamic";
export const revalidate = false;

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
