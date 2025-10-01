import type { TraceSpan } from '@evilmartians/agent-prism-types';

import { CollapsibleSection } from '../CollapsibleSection';
import { TextInput } from '../TextInput';

interface AttributesTabProps {
  data: TraceSpan;
}

export const DetailsViewAttributesTab = ({ data }: AttributesTabProps) => (
  <div className="space-y-6">
    {(!data.attributes || data.attributes.length === 0) && (
      <div className="p-6 text-center">
        <p className="text-muted-foreground ">No attributes available for this span.</p>
      </div>
    )}

    {(data.attributes || []).map((attribute, index) => {
      const value =
        attribute.value.stringValue ||
        attribute.value.intValue ||
        attribute.value.boolValue?.toString() ||
        'N/A';

      return (
        <CollapsibleSection key={`${attribute.key}-${index}`} title={attribute.key} defaultOpen>
          <TextInput
            id={`${data.id}-attribute-${index}`}
            value={value}
            disabled
            readOnly
            inputClassName="font-mono text-xs"
            className="w-full"
          />
        </CollapsibleSection>
      );
    })}
  </div>
);
