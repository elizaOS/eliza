/**
 * Share buttons component providing social sharing and copy link functionality.
 * Supports native share API, Twitter sharing, and clipboard copy.
 *
 * @param props.url - URL to share
 * @param props.title - Title for sharing
 * @param props.description - Optional description for sharing
 */
interface ShareButtonsProps {
  url: string;
  title: string;
  description?: string;
}
export declare function ShareButtons({
  url,
  title,
  description,
}: ShareButtonsProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=share-buttons.d.ts.map
