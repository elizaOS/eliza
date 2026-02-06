import React from "react";
import { useTranslation } from "react-i18next";

import { useDropzone } from "react-dropzone";

const loadJSONFile = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onabort = () => reject(new Error("file reading was aborted"));
    reader.onerror = () => reject(new Error("file reading has failed"));
    reader.onload = () => {
      try {
        const result = JSON.parse(reader.result);
        resolve({ game: result });
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsText(file);
  });
};

const loadZIPFile = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onabort = () => reject(new Error("file reading was aborted"));
    reader.onerror = () => reject(new Error("file reading has failed"));
    reader.onload = async () => {
      try {
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        await zip.loadAsync(reader.result);
        const data = JSON.parse(await zip.file("content.json").async("string"));

        const fileList = [];

        zip.forEach((relativePath, zipEntry) =>
          fileList.push(
            (async () => [
              relativePath,
              new File([await zipEntry.async("blob")], relativePath),
            ])()
          )
        );

        const files = Object.fromEntries(await Promise.all(fileList));

        resolve({ game: data, files });
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsBinaryString(file);
  });
};

const LoadGame = ({ onLoad = () => {} }) => {
  const { t } = useTranslation();

  const onDrop = React.useCallback(
    (acceptedFiles) => {
      acceptedFiles.forEach(async (file) => {
        try {
          const result = await loadJSONFile(file);
          onLoad(result);
        } catch (e) {
          try {
            const result = await loadZIPFile(file);
            onLoad(result);
          } catch (e) {
            console.log("File parsing failed", e);
          }
        }
      });
    },
    [onLoad]
  );

  const { getRootProps, getInputProps } = useDropzone({ onDrop });

  return (
    <div
      {...getRootProps()}
      style={{
        border: "1px dashed white",
        padding: "0.5em",
        cursor: "pointer",
        fontSize: "1.5em",
      }}
    >
      <input {...getInputProps()} />
      <p style={{ textAlign: "center", margin: "1em" }}>
        {t("Dragn drop file here")}
      </p>
    </div>
  );
};

export default LoadGame;
