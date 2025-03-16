// Update the IAttachment interface
/**
 * Interface representing an attachment.
 * @interface
 * @property {string} url - The URL of the attachment.
 * @property {string} [contentType] - The content type of the attachment, optional.
 * @property {string} title - The title of the attachment.
 */
export interface IAttachment {
  url: string;
  contentType?: string; // Make contentType optional
  title: string;
}
