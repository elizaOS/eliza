import React from "react";
import { FormSpy } from "react-final-form";
import { objectDiff } from "../../utils";

const AutoSaveIn = ({ values, save }) => {
  const [prevValues, setPrevValues] = React.useState(values);

  React.useEffect(() => {
    const differences = objectDiff(prevValues, values);
    if (differences) {
      setPrevValues(values);
      save(differences);
    }
  }, [values, save, prevValues]);

  return null;
};

const AutoSave = (props) => (
  <FormSpy {...props} subscription={{ values: true }} component={AutoSaveIn} />
);

export default AutoSave;
