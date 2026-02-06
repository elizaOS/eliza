import React from "react";
import styled from "styled-components";
import { useTranslation } from "react-i18next";
import { useDropzone } from "react-dropzone";
import loadVassalModule from "../utils/vassal.js";

const Game = styled.li`
  position: relative;
  padding: 0em;
  margin: 0px;

  & .game-name {
    max-width: 80%;
    line-height: 1.2em;
    overflow: hidden;
    margin-bottom: 3px;
    margin: 0.2em 0 0.5em 0;
    font-size: 2.3vw;
  }

  & .img-wrapper {
    display: block;
    position: relative;
    width: 100%;
    padding-top: 64.5%;
    & > span {
      background-color: var(--color-blueGrey);
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      right: 0;
      overflow: hidden;
      display: flex;
      justify-content: center;
      border-radius: 5px;
      & img {
        flex: 0;
      }
    }
  }

  @media screen and (max-width: 1024px) {
    & {
      flex-basis: 45%;
    }
    & .details {
      font-size: 12px;
    }
    & .game-name {
      font-size: 28px;
    }
  }

  @media screen and (max-width: 640px) {
    & {
      flex-basis: 100%;
    }
    & .game-name {
      font-size: 24px;
    }
  }
`;

const VassalImportGameItem = () => {
  const { t } = useTranslation();

  const { getRootProps, getInputProps } = useDropzone({
    onDrop: async (files) => {
      loadVassalModule(files[0]);
    },
  });

  return (
    <Game>
      <div
        {...getRootProps()}
        style={{
          border: "3px dashed white",
          margin: "0.5em",
          padding: "0.5em",
          textAlign: "center",
        }}
      >
        <input {...getInputProps()} />
        <p>{t("Click or drag'n'drop file here")}</p>
      </div>
      <div className="details">
        <span></span>
      </div>

      <h2 className="game-name">{t("Import Vassal module")}</h2>
    </Game>
  );
};

export default VassalImportGameItem;
