import React from "react";
import { useTranslation } from "react-i18next";
import { FiDownload } from "react-icons/fi";
import pLimit from "p-limit";
import mime from "mime-types";

import { itemTemplates } from "../../gameComponents";
import { media2Url } from "../../mediaLibrary";
import { uid } from "../../utils";
import { availableItemVisitor } from "../../utils/item";
import { triggerFileDownload } from "../../utils";
import { URLAsBlob, hashBlob } from "../../utils/image";

class ZipBuilder {
  async putFileInZip(url) {
    if (!this.cache[url]) {
      this.cache[url] = (async () => {
        const blob = await URLAsBlob(url);
        const hash = await hashBlob(blob);

        if (this.hashCache[hash]) {
          return this.hashCache[hash];
        } else {
          const extension = mime.extension(blob.type);
          const filename = `${uid()}.${extension}`;
          this.zip.file(filename, blob);
          this.hashCache[hash] = filename;
          this.incFileCount();
          return filename;
        }
      })();
    }
    return this.cache[url];
  }

  async exportMediaToZip(media) {
    const url = media2Url(media);
    if (url) {
      try {
        const filename = await this.queue(this.putFileInZip.bind(this), url);
        return { file: filename };
      } catch (e) {
        console.warn("Failed to export file", url);
        return null;
      }
    }
    return media;
  }

  async addImageToZipFromItem(item) {
    const template = itemTemplates[item.type];
    const itemCloned = JSON.parse(JSON.stringify(item));

    await template.mapMedia(itemCloned, async (media) => {
      return this.exportMediaToZip(media);
    });

    return itemCloned;
  }

  async build(data, incFileCount = () => {}, withFile = false) {
    this.cache = {};
    this.hashCache = {};
    const JSZip = (await import("jszip")).default;
    this.zip = new JSZip();
    this.queue = pLimit(4);
    this.incFileCount = incFileCount;

    delete data.board.published;

    if (withFile) {
      data.items = await Promise.all(
        data.items.map(this.addImageToZipFromItem.bind(this))
      );
      data.availableItems = await availableItemVisitor(
        data.availableItems,
        this.addImageToZipFromItem.bind(this)
      );

      data.board.imageUrl = await this.exportMediaToZip(data.board.imageUrl);
      if (data.board?.bgConf?.img) {
        data.board.bgConf.img = await this.exportMediaToZip(
          data.board.bgConf.img
        );
      }
    }

    this.zip.file("content.json", JSON.stringify(data));
    const base64 = await this.zip.generateAsync({ type: "base64" });
    const url = "data:application/zip;base64," + base64;

    return url;
  }
}

export const DownloadLink = ({ getData = () => {}, withFile = false }) => {
  const { t } = useTranslation();

  const [generating, setGenerating] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [fileCount, setFileCount] = React.useState(0);

  const triggerDownload = React.useCallback(async () => {
    const data = await getData();

    if (data.items.length) {
      setGenerating(true);
      setFileCount(0);
      setError(false);
      try {
        const zipBuilder = new ZipBuilder();
        const url = await zipBuilder.build(
          JSON.parse(JSON.stringify(data)),
          () => {
            setFileCount((prev) => prev + 1);
          },
          withFile
        );
        triggerFileDownload(url, `airboardgame_${Date.now()}.zip`);
      } catch (e) {
        console.error(e);
        setError(true);
      } finally {
        setFileCount(0);
        setGenerating(false);
      }
    }
  }, [getData, withFile]);

  return (
    <>
      <button className="button success icon" onClick={triggerDownload}>
        {!generating
          ? t("Export")
          : `#${fileCount} - ${t("Generating export")} `}
        {!generating && <FiDownload size="20" color="#f9fbfa" alt="Download" />}
      </button>
      {error && <p className="error">{t("An error occurred. Try again!")}</p>}
    </>
  );
};

export default DownloadLink;
