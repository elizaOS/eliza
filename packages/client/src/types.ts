// Update the IAttachment interface
export interface IAttachment {
    url: string;
    contentType?: string; // Make contentType optional
    title: string;
}