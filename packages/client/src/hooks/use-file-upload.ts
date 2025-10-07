import { useState, useRef, useEffect, useCallback } from 'react';
import { getContentTypeFromMimeType } from '@elizaos/core';
import { UUID, Media, ChannelType } from '@elizaos/core';
import { randomUUID } from '@/lib/utils';
import { createElizaClient } from '@/lib/api-client-config';
import { useToast } from '@/hooks/use-toast';
// Direct error handling
import clientLogger from '@/lib/logger';

export type UploadingFile = {
  file: File;
  id: string;
  isUploading: boolean;
  uploadProgress?: number;
  error?: string;
  blobUrl?: string;
};

interface UseFileUploadProps {
  agentId?: UUID;
  channelId?: UUID;
  chatType: ChannelType.DM | ChannelType.GROUP;
}

export function useFileUpload({ agentId, channelId, chatType }: UseFileUploadProps) {
  const [selectedFiles, setSelectedFiles] = useState<UploadingFile[]>([]);
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const { toast } = useToast();
  const elizaClient = createElizaClient();

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current.clear();
    };
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      const validFiles = files.filter(
        (file) =>
          file.type.startsWith('image/') ||
          file.type.startsWith('video/') ||
          file.type.startsWith('audio/') ||
          file.type === 'application/pdf' ||
          file.type === 'application/msword' ||
          file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
          file.type === 'application/vnd.ms-excel' ||
          file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          file.type === 'application/vnd.ms-powerpoint' ||
          file.type ===
            'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
          file.type.startsWith('text/')
      );

      const uniqueFiles = validFiles.filter((newFile) => {
        return !selectedFiles.some(
          (existingFile) =>
            existingFile.file.name === newFile.name &&
            existingFile.file.size === newFile.size &&
            existingFile.file.lastModified === newFile.lastModified
        );
      });

      const newUploadingFiles: UploadingFile[] = uniqueFiles.map((file) => ({
        file,
        id: randomUUID(),
        isUploading: false,
      }));

      setSelectedFiles((prev) => {
        const combined = [...prev, ...newUploadingFiles];
        return Array.from(
          new Map(combined.map((f) => [`${f.file.name}-${f.file.size}`, f])).values()
        );
      });
      if (e.target) e.target.value = '';
    },
    [selectedFiles]
  );

  const removeFile = useCallback((fileId: string) => {
    setSelectedFiles((prev) => {
      const file = prev.find((f) => f.id === fileId);
      if (file?.blobUrl) {
        URL.revokeObjectURL(file.blobUrl);
        blobUrlsRef.current.delete(file.blobUrl);
      }
      return prev.filter((f) => f.id !== fileId);
    });
  }, []);

  const createBlobUrls = useCallback((files: UploadingFile[]): Media[] => {
    const attachmentBlobUrls: string[] = [];
    const optimisticAttachments = files
      .map((sf) => {
        const blobUrl = URL.createObjectURL(sf.file);
        blobUrlsRef.current.add(blobUrl);
        attachmentBlobUrls.push(blobUrl);
        sf.blobUrl = blobUrl;
        return {
          id: sf.id,
          url: blobUrl,
          title: sf.file.name,
          contentType: getContentTypeFromMimeType(sf.file.type),
          isUploading: true,
        };
      })
      .filter((att) => att.contentType !== undefined) as Media[];

    return optimisticAttachments;
  }, []);

  const uploadFiles = useCallback(
    async (
      files: UploadingFile[]
    ): Promise<{
      uploaded: Media[];
      failed: Array<{ file: UploadingFile; error: string }>;
      blobUrls: string[];
    }> => {
      if (!files.length) return { uploaded: [], failed: [], blobUrls: [] };

      const uploadPromises = files.map(async (fileData) => {
        try {
          const uploadResult =
            chatType === ChannelType.DM && agentId
              ? await elizaClient.media.uploadAgentMedia(agentId, {
                  file: fileData.file,
                  filename: fileData.file.name,
                })
              : await elizaClient.media.uploadChannelMedia(channelId!, fileData.file);

          return {
            success: true,
            media: {
              id: fileData.id,
              url: uploadResult.url,
              title: fileData.file.name,
              source: 'file_upload',
              contentType: getContentTypeFromMimeType(fileData.file.type),
            } as Media,
          };
        } catch (uploadError) {
          clientLogger.error(`Failed to upload ${fileData.file.name}:`, uploadError);

          // Direct error handling
          toast({
            title: `Upload Failed: ${fileData.file.name}`,
            description: uploadError instanceof Error ? uploadError.message : 'Upload failed',
            variant: 'destructive',
          });

          return {
            success: false,
            file: fileData,
            error: uploadError instanceof Error ? uploadError.message : 'Upload failed',
          };
        }
      });

      const settledUploads = await Promise.allSettled(uploadPromises);
      const uploaded: Media[] = [];
      const failed: Array<{ file: UploadingFile; error: string }> = [];
      const blobUrls: string[] = [];

      settledUploads.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          if (result.value.success && 'media' in result.value) {
            uploaded.push(result.value.media as Media);
          } else if ('file' in result.value) {
            failed.push(result.value as { file: UploadingFile; error: string });
          }
        } else {
          // Handle rejected promise
          failed.push({
            file: files[index],
            error: result.reason?.message || 'Upload failed',
          });
        }
      });

      // Collect blob URLs for cleanup
      files.forEach((f) => {
        if (f.blobUrl) blobUrls.push(f.blobUrl);
      });

      return { uploaded, failed, blobUrls };
    },
    [chatType, agentId, channelId, toast]
  );

  const cleanupBlobUrls = useCallback((urls: string[]) => {
    urls.forEach((url) => {
      URL.revokeObjectURL(url);
      blobUrlsRef.current.delete(url);
    });
  }, []);

  const clearFiles = useCallback(() => {
    // Cleanup all blob URLs
    selectedFiles.forEach((file) => {
      if (file.blobUrl) {
        URL.revokeObjectURL(file.blobUrl);
        blobUrlsRef.current.delete(file.blobUrl);
      }
    });
    setSelectedFiles([]);
  }, [selectedFiles]);

  return {
    selectedFiles,
    setSelectedFiles,
    handleFileChange,
    removeFile,
    createBlobUrls,
    uploadFiles,
    cleanupBlobUrls,
    clearFiles,
    getContentTypeFromMimeType,
  };
}
