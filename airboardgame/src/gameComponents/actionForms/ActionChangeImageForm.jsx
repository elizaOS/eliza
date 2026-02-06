import React from "react";
import { useTranslation } from "react-i18next";
import { Field } from "react-final-form";

import Label from "../../ui/formUtils/Label";

const Form = ({ name, initialValues = { step: 1, layer: 0 } }) => {
  const { t } = useTranslation();
  return (
    <>
      <Label>
        {t("Step")}
        <Field
          name={`${name}.step`}
          component="input"
          parse={(value) => parseInt(value, 10) || 1}
          initialValue={initialValues.step}
        />
      </Label>
    </>
  );
};

export default Form;
