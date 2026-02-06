import React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { MediaLibraryButton, media2Url } from "./";
import backgroundGrid from "../media/images/background-grid.png";
import { getImage } from "../utils/image";

const StyledImageField = styled.div`
  display: flex;
  justify-content: center;
  background-color: #ffffff22;
  padding: 0.5em 0.2em;

  & .typeSelect {
    padding: 0.5em 0;
    display: flex;
    flex-direction: column;
  }
  & .imgContainer {
    flex: 1;
    position: relative;
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    gap: 0.5em;

    input {
      width: 130px;
    }
  }
`;

const Thumbnail = styled.img`
  max-height: 100px;
  display: block;
  background-image: url(${backgroundGrid});
`;

const ensureMedia = (val) => {
  if (typeof val === "string") {
    return { type: "external", content: val };
  } else {
    return val;
  }
};

const ImageField = ({ value, onChange, onImageLoaded }) => {
  const { t } = useTranslation();
  let type, content;

  // Manage compat with old version
  if (typeof value === "object") {
    type = value.type;
    content = value.content;
  } else {
    if (value) {
      type = "external";
      content = value;
    } else {
      type = "empty";
      content = null;
    }
  }

  const handleInputChange = (e) => {
    onChange({ ...ensureMedia(value), type, content: e.target.value });
  };

  const handleTypeChange = (e) => {
    onChange({ ...ensureMedia(value), type: e.target.value, content: "" });
  };

  const handleMediaSelect = (key) => {
    onChange({ ...ensureMedia(value), type: "local", content: key });
  };

  const url = media2Url(value);

  React.useEffect(() => {
    if (url && onImageLoaded) {
      getImage(url).then(onImageLoaded);
    }
  }, [url, onImageLoaded]);

  return (
    <StyledImageField>
      <form className="typeSelect">
        <label>
          <input
            type="radio"
            value="empty"
            onChange={handleTypeChange}
            checked={type === "empty"}
          />
          {t("No image")}
        </label>
        <label>
          <input
            type="radio"
            value="local"
            onChange={handleTypeChange}
            checked={type === "local"}
          />
          {t("Library")}
        </label>
        <label>
          <input
            type="radio"
            value="external"
            checked={type === "external"}
            onChange={handleTypeChange}
          />
          {t("External")}
        </label>
      </form>

      <div className="imgContainer" onClick={(e) => e.preventDefault()}>
        {type !== "empty" && content && (
          <Thumbnail
            src={url}
            onError={(e) => (e.target.src = "/default.png")}
          />
        )}

        {type === "external" && (
          <input
            value={content}
            placeholder={t("Enter an image url...")}
            onChange={handleInputChange}
          />
        )}
        {type === "local" && (
          <MediaLibraryButton
            onSelect={handleMediaSelect}
            label={content ? t("Change image") : t("Select image")}
          />
        )}
      </div>
    </StyledImageField>
  );
};

export default ImageField;
