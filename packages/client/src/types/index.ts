/**
 * Interface representing an attachment.
 *
 * @interface
 * @property {string} url - The URL of the attachment.
 * @property {string} contentType - The content type of the attachment.
 * @property {string} title - The title of the attachment.
 */
export interface IAttachment {
  url: string;
  contentType: string;
  title: string;
}
