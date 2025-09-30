import type { TraceSpan } from "@evilmartians/agent-prism-types";

import JSONPretty from "react-json-pretty";
import colors from "tailwindcss/colors";

interface RawDataTabProps {
  data: TraceSpan;
}

export const DetailsViewRawDataTab = ({ data }: RawDataTabProps) => (
  <div className="pt-4">
    <div className="rounded border border-gray-200 bg-transparent dark:border-gray-800">
      <JSONPretty
        booleanStyle={`color: ${colors.blue[400]};`}
        className="overflow-x-auto rounded-xl p-4 text-left"
        data={data.raw}
        id={`json-pretty-${data.id || "span-details"}`}
        keyStyle={`color: ${colors.blue[400]};`}
        mainStyle={`color: ${colors.gray[400]}; font-size: 12px;`}
        stringStyle={`color: ${colors.red[600]};`}
        valueStyle={`color: ${colors.red[600]};`}
      />
    </div>
  </div>
);
