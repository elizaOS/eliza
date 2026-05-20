import type { Metadata } from 'next';
import { ModelPilotInquiryForm } from '@/components/model-pilot/ModelPilotInquiryForm';

export const metadata: Metadata = {
  title: 'Bring Your Model to Feed',
  description:
    'Request a model pilot: connect your model, run scenarios, and receive data or fine-tuning.',
  robots: { index: false, follow: false },
};

export default function ResearchInquiryPage() {
  return <ModelPilotInquiryForm />;
}
