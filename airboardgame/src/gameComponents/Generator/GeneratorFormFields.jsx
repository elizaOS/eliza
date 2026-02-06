import React from "react";
import { useTranslation } from "react-i18next";
import { Field, useField } from "react-final-form";
import { useItemActions } from "react-sync-board";
import styled from "styled-components";

import Label from "../../ui/formUtils/Label";
import SidePanel from "../../ui/SidePanel";
import ItemFormFactory from "../../views/BoardView/ItemFormFactory";
import itemTemplates from "../itemTemplates";

const CardContent = styled.div.attrs(() => ({ className: "content" }))`
  display: flex;
  flex-direction: column;
  padding: 0.5em;
`;

const extraExcludeFields = { locked: true, layer: true };

const EditSubItemButton = ({ showEdit, setShowEdit, subItem, onUpdate }) => {
  const { t } = useTranslation();

  return (
    <>
      <button onClick={() => setShowEdit((prev) => !prev)}>
        {t("Edit generated item")}
      </button>
      <SidePanel
        layer={1}
        open={showEdit}
        onClose={() => {
          setShowEdit(false);
        }}
        title={t("Generated item")}
        width="25%"
      >
        <CardContent>
          <ItemFormFactory
            onUpdate={onUpdate}
            items={[subItem]}
            extraExcludeFields={extraExcludeFields}
          />
        </CardContent>
      </SidePanel>
    </>
  );
};

const Form = ({ initialValues }) => {
  const { t } = useTranslation();
  const {
    input: { value: itemType },
  } = useField("item.type", { initialValue: initialValues.item?.type });

  const [showEdit, setShowEdit] = React.useState(false);

  const { batchUpdateItems } = useItemActions();

  const onSubmitHandler = React.useCallback(
    (formValues) => {
      batchUpdateItems(initialValues.id, (item) => {
        return {
          ...item,
          item: {
            ...item.item,
            ...formValues,
          },
        };
      });
    },
    [batchUpdateItems, initialValues.id]
  );

  return (
    <>
      <Label>
        {t("Label")}
        <Field
          name="text"
          component="input"
          initialValue={initialValues.text}
        />
      </Label>

      <Label>
        {t("Item type")}
        <Field
          name="item.type"
          component="select"
          initialValue={initialValues.item?.type}
        >
          <option />
          {Object.keys(itemTemplates).map((key) => {
            if (key === "generator") {
              return null;
            }
            return (
              <option key={key} value={key}>
                {itemTemplates[key].name}
              </option>
            );
          })}
        </Field>
      </Label>

      {itemType && (
        <EditSubItemButton
          showEdit={showEdit}
          setShowEdit={setShowEdit}
          subItem={initialValues.item}
          onUpdate={onSubmitHandler}
        />
      )}
    </>
  );
};

export default Form;
