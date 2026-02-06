import React from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "react-query";
import styled from "styled-components";

import { API_BASE } from "../utils/settings";
import backgroundGrid from "../media/images/background-grid.png";

import { confirmAlert } from "react-confirm-alert";
import { toast } from "react-toastify";

import Modal from "../ui/Modal";

import { useMediaLibrary } from ".";
import { useDropzone } from "react-dropzone";

const ImageGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  & > div {
    position: relative;
  }
  & img {
    height: 100px;
    margin: 0.5em;
    cursor: pointer;
    border: 1px solid transparent;
    background-image: url(${backgroundGrid});
    &:hover {
      filter: brightness(1.2);
      border: 1px dotted var(--color-primary);
    }
  }
  & .remove {
    position: absolute;
    top: 15px;
    right: 5px;
  }
`;

const MediaLibraryModal = ({ show, setShow, onSelect }) => {
  const { t } = useTranslation();

  const [fileUploading, setFileUploading] = React.useState(false);

  const {
    getLibraryMedia,
    addMedia,
    removeMedia,
    libraries,
  } = useMediaLibrary();

  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState(libraries[0].id);

  const currentLibrary = libraries.find(({ id }) => id === tab);

  const { isLoading, data = [], isError } = useQuery(
    `media__${tab}`,
    () => getLibraryMedia(currentLibrary),
    {
      enabled: show,
    }
  );

  const handleSelect = React.useCallback(
    (media) => {
      onSelect(media);
      setShow(false);
    },
    [onSelect, setShow]
  );

  const uploadMediaMutation = useMutation(
    async (files) => {
      setFileUploading(true);
      if (files.length === 1) {
        return [await addMedia(currentLibrary, files[0])];
      } else {
        return Promise.all(files.map((file) => addMedia(currentLibrary, file)));
      }
    },
    {
      onSuccess: (result) => {
        setFileUploading(false);
        if (result.length === 1) {
          // If only one file is processed
          handleSelect(result[0].content);
        }
        queryClient.invalidateQueries(`media__${tab}`);
      },
    }
  );

  const onRemove = React.useCallback(
    (key) => {
      confirmAlert({
        title: t("Confirmation"),
        message: t("Do you really want to remove this media?"),
        buttons: [
          {
            label: t("Yes"),
            onClick: async () => {
              try {
                await removeMedia(key);
                toast.success(t("Media deleted"), { autoClose: 1500 });
              } catch (e) {
                if (e.message === "Forbidden") {
                  toast.error(t("Action forbidden. Try logging in again."));
                } else {
                  console.log(e);
                  toast.error(
                    t("Error while deleting media. Try again later...")
                  );
                }
              }
            },
          },
          {
            label: t("No"),
            onClick: () => {},
          },
        ],
      });
    },
    [removeMedia, t]
  );

  const { getRootProps, getInputProps } = useDropzone({
    onDrop: uploadMediaMutation.mutate,
  });

  return (
    <Modal
      title={t("Media library")}
      show={show}
      setShow={setShow}
      position="left"
    >
      <nav className="tabs">
        {libraries.map(({ id, name }) => (
          <a
            onClick={() => setTab(id)}
            className={tab === id ? "active" : ""}
            style={{ cursor: "pointer" }}
            key={id}
          >
            {name}
          </a>
        ))}
      </nav>

      <section>
        {libraries.map(({ id, name }, index) => {
          if (tab === id) {
            return (
              <div key={id}>
                {index === 0 && (
                  <>
                    <h3>{t("Add file")}</h3>
                    {!fileUploading && (
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
                    )}
                    {fileUploading && <div>{t("Uploading image(s)...")}</div>}
                  </>
                )}
                <h3>{name}</h3>
                {!isLoading && !isError && (
                  <ImageGrid>
                    {data.map((key) => (
                      <div key={key}>
                        <img
                          src={`${API_BASE}/${key}`}
                          onClick={() => handleSelect(key)}
                        />
                        <button
                          onClick={() => onRemove(key)}
                          className="button icon-only remove"
                          title={t("Remove")}
                        >
                          X
                        </button>
                      </div>
                    ))}
                  </ImageGrid>
                )}
              </div>
            );
          } else {
            return null;
          }
        })}
      </section>
    </Modal>
  );
};

export default MediaLibraryModal;
