import React from "react";
import { useTranslation } from "react-i18next";

import { useDropzone } from "react-dropzone";

import useSession from "../../hooks/useSession";
import useLocalStorage from "../../hooks/useLocalStorage";
import { loadVassalModuleInSession } from "../../utils/vassal.js";

const LoadVassalModule = ({ onLoad = () => {}, onStart = () => {} }) => {
  const { t } = useTranslation();
  const { sessionId, saveSession, setSession } = useSession();
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [messages, setMessages] = React.useState([]);

  const [isBeta] = useLocalStorage("isBeta", false);

  const onDrop = React.useCallback(
    async (acceptedFiles) => {
      setLoading(true);
      setMessages([]);
      onStart();
      await saveSession(true);
      try {
        const result = await loadVassalModuleInSession(
          acceptedFiles[0],
          sessionId,
          (progress, message) => {
            setProgress(progress);
            setMessages((prev) => {
              const newMessage = [...prev, message];
              if (newMessage.length > 5) {
                newMessage.shift();
              }
              return newMessage;
            });
          },
          isBeta
        );
        setSession(result);
        onLoad();
      } catch (e) {
        console.log(e);
        setLoading(false);
        setMessages([
          t("Error while loading the module, please report the error..."),
        ]);
        onLoad(e);
        throw e;
      }
    },
    [onStart, saveSession, sessionId, isBeta, setSession, onLoad, t]
  );

  const { getRootProps, getInputProps } = useDropzone({ onDrop });

  if (!loading) {
    return (
      <div>
        <ul style={{ listStyleType: "none", paddingLeft: "5px", color: "red" }}>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
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
            {t("Drag'n'drop a vassal module here")}
          </p>
        </div>
      </div>
    );
  } else {
    return (
      <div>
        <h2>{t("Loading...") + `${progress}%`}</h2>
        <ul style={{ listStyleType: "none", paddingLeft: "5px" }}>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      </div>
    );
  }
};

export default LoadVassalModule;
