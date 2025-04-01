import { FarcasterService } from './service';
import { FarcasterTestSuite } from '../__tests__/suite';

const farcasterPlugin = {
  name: 'farcaster',
  description: 'Farcaster client plugin',
  services: [FarcasterService],
  tests: [new FarcasterTestSuite()],
};
export default farcasterPlugin;
