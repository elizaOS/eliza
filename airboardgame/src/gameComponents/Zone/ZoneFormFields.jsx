import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../../ui/formUtils/Label";
import Hint from "../../ui/formUtils/Hint";
import ColorPicker from "../../ui/formUtils/ColorPicker";

import ActionList from "../ActionList";

const interactions = ["reveal", "hide", "revealSelf", "stack", "rollLayer"];

const Form = ({ initialValues }) => {
  const { t } = useTranslation();

  const initOnItem = React.useMemo(
    () =>
      (initialValues.onItem || []).map((action) => {
        if (typeof action === "string") {
          return { name: action };
        }
        return action;
      }),
    [initialValues.onItem]
  );

  return (
    <>
      <Label>
        {t("Label")}
        <Field
          name="label"
          component="input"
          initialValue={initialValues.label}
        />
      </Label>
      <Label>
        {t("Width")}
        <Field
          name="width"
          component="input"
          initialValue={initialValues.width}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>
      <Label>
        {t("Height")}
        <Field
          name="height"
          component="input"
          initialValue={initialValues.height}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>
      <Label>
        {t("Background color")}
        <Field
          name="backgroundColor"
          component="input"
          initialValue={initialValues.backgroundColor || "#CCCCCC00"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker
              value={value}
              onChange={onChange}
              disableAlpha={false}
            />
          )}
        </Field>
      </Label>
      <Label>
        {t("Border color")}
        <Field
          name="borderColor"
          component="input"
          initialValue={initialValues.borderColor || "#CCCCCC33"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker
              value={value}
              onChange={onChange}
              disableAlpha={false}
            />
          )}
        </Field>
      </Label>
      <Label>
        {t("Border style")}
        <Field
          name="borderStyle"
          component="select"
          initialValue={initialValues.borderStyle || "dotted"}
          style={{ width: "10em" }}
        >
          <option value="dotted">{t("Dotted")}</option>
          <option value="Solid">{t("solid")}</option>
          <option value="dashed">{t("Dashed")}</option>
        </Field>
      </Label>

      <Label>
        {t("Label position")}
        <Field
          name="labelPosition"
          component="select"
          initialValue={initialValues.labelPosition || "left"}
          style={{ width: "10em" }}
        >
          <option value="left">{t("Left")}</option>
          <option value="top">{t("Top")}</option>
        </Field>
      </Label>

      <Label>
        {t("Hold items")}
        <Field
          name="holdItems"
          component="input"
          type="checkbox"
          initialValue={initialValues.holdItems}
        />
        <Hint>
          {t(
            "Whether we can place items on it. When an item is placed, moving the current item one also moves the placed items."
          )}
        </Hint>
      </Label>

      <h3>{t("Interactions")}</h3>
      <Hint>{t("Interaction help")}</Hint>
      <Label>
        <ActionList
          name="onItem"
          initialValue={initOnItem}
          availableActions={interactions}
        />
      </Label>
    </>
  );
};

export default Form;
