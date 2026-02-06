import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../../ui/formUtils/Label";
import ColorPicker from "../../ui/formUtils/ColorPicker";

const Form = ({ initialValues }) => {
  const { t } = useTranslation();
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
          initialValue={initialValues.width || 300}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>
      <Label>
        {t("Height")}
        <Field
          name="height"
          component="input"
          initialValue={initialValues.height || 200}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>
      <Label>
        {t("Color")}
        <Field
          name="color"
          component="input"
          initialValue={initialValues.color || "#FFEC27"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker value={value} onChange={onChange} />
          )}
        </Field>
      </Label>
      <Label>
        {t("Font size")}
        <Field
          name="fontSize"
          component="input"
          initialValue={initialValues.fontSize || 20}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>
      <Label>
        {t("Font family")}
        <Field
          name="fontFamily"
          component="select"
          initialValue={initialValues.fontFamily || "Roboto"}
          style={{ width: "10em" }}
        >
          <option value="Roboto">Roboto</option>
          <option value="Satisfy">Satisfy</option>
        </Field>
      </Label>
      <Label>
        {t("Text color")}
        <Field
          name="textColor"
          component="input"
          initialValue={initialValues.textColor || "#000"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker value={value} onChange={onChange} />
          )}
        </Field>
      </Label>
    </>
  );
};

export default Form;
