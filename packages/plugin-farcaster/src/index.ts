import { FarcasterService } from './service';

const farcasterPlugin = {
  name: 'farcaster',
  description: 'Farcaster client plugin',
  services: [FarcasterService],
  // FIXME: hish - tests: [new FarcasterTestSuite()],
};
export default farcasterPlugin;
