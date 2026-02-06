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
        {t("Side count")}
        <Field
          name="side"
          component="input"
          initialValue={initialValues.side || 6}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>

      <Label>
        {t("Color")}
        <Field
          name="color"
          component="input"
          initialValue={initialValues.color || "#ccc"}
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
          initialValue={initialValues.fontSize || 35}
        >
          {(props) => <input {...props.input} type="number" />}
        </Field>
      </Label>

      <Label>
        {t("Text color")}
        <Field
          name="textColor"
          component="input"
          initialValue={initialValues.textColor || "#fff"}
        >
          {({ input: { onChange, value } }) => (
            <ColorPicker
              value={value}
              onChange={onChange}
              disableAlpha={true}
            />
          )}
        </Field>
      </Label>
    </>
  );
};

export default Form;
