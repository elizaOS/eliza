import React from "react";
import { useDropzone } from "react-dropzone";
import { useTranslation } from "react-i18next";
import { useItemActions } from "react-sync-board";

import { uid } from "../utils";
import { useMediaLibrary } from "./MediaLibraryProvider";
import Waiter from "../ui/Waiter";

const ImageDropNPaste = ({ children }) => {
  const { t } = useTranslation();
  const [uploading, setUploading] = React.useState(false);
  const { pushItem } = useItemActions();

  const { addMedia, libraries } = useMediaLibrary();

  const addImageItem = React.useCallback(
    async (media) => {
      pushItem({
        type: "image",
        id: uid(),
        content: media,
      });
    },
    [pushItem]
  );

  const onDrop = React.useCallback(
    async (acceptedFiles) => {
      setUploading(true);
      try {
        await Promise.all(
          acceptedFiles.map(async (file) => {
            const media = await addMedia(libraries[0], file);
            await addImageItem(media);
          })
        );
      } finally {
        setUploading(false);
      }
    },
    [addImageItem, addMedia, libraries]
  );

  const { getRootProps } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    accept: {
      "image/png": [".png"],
      "image/jpg": [".jpg", ".jpeg"],
      "image/svg+xml": [".svg"],
      "image/tiff": [".tif", ".tiff"],
      "image/webp": [".webp"],
      "image/gif": [".gif"],
    },
  });

  const onPaste = React.useCallback(
    async (e) => {
      const { items } = e.clipboardData;
      setUploading(true);
      // eslint-disable-next-line no-plusplus
      try {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.indexOf("image") !== -1) {
            const file = item.getAsFile();
            // eslint-disable-next-line no-await-in-loop
            const location = await addMedia(libraries[0], file);
            // eslint-disable-next-line no-await-in-loop
            await addImageItem(location);
          }
        }
      } finally {
        setUploading(false);
      }
    },
    [addImageItem, addMedia, libraries]
  );

  React.useEffect(() => {
    window.addEventListener("paste", onPaste, false);

    return () => {
      window.removeEventListener("paste", onPaste);
    };
  }, [onPaste]);

  return (
    <div {...getRootProps()} style={{ overflow: "hidden" }}>
      {children}
      {uploading && <Waiter message={t("Uploading image(s)...")} />}
    </div>
  );
};

export default ImageDropNPaste;
