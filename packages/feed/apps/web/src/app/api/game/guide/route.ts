import { successResponse, withErrorHandling } from '@babylon/api';
import { GAME_GUIDE_SLIDES } from '@/components/onboarding/game-guide-slides';

export { POST } from '../../users/me/game-guide/route';

export const GET = withErrorHandling(async () => {
  return successResponse({
    success: true,
    slides: GAME_GUIDE_SLIDES,
  });
});
