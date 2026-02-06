import React from "react";
import { useTranslation } from "react-i18next";
import MediaLibraryModal from "./MediaLibraryModal";

const MediaLibraryButton = ({ onSelect, label }) => {
  const { t } = useTranslation();

  const [showLibrary, setShowLibrary] = React.useState(false);

  return (
    <>
      <button onClick={() => setShowLibrary((prev) => !prev)}>
        {label || t("Select media")}
      </button>

      <MediaLibraryModal
        show={showLibrary}
        setShow={setShowLibrary}
        onSelect={onSelect}
      />
    </>
  );
};

export default MediaLibraryButton;
