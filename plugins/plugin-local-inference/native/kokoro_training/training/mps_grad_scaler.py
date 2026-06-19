import torch


class MPSGradScaler:
    """
    A custom gradient scaler for MPS that mimics CUDA's GradScaler behavior.
    MPS doesn't have a built-in GradScaler, so we implement basic scaling functionality.
    """

    def __init__(self, init_scale=65536.0, growth_factor=2.0, backoff_factor=0.5, growth_interval=2000):
        self._scale = init_scale
        self.growth_factor = growth_factor
        self.backoff_factor = backoff_factor
        self.growth_interval = growth_interval
        self._growth_tracker = 0
        self._enabled = True

    def get_scale(self):
        return self._scale

    def scale(self, loss):
        """Scale the loss"""
        if not self._enabled:
            return loss
        return loss * self._scale

    def unscale_(self, optimizer):
        """Unscale gradients - for MPS we'll do this during step()"""
        pass  # MPS implementation will handle this in step()

    def step(self, optimizer):
        """Step the optimizer with gradient unscaling"""
        if not self._enabled:
            optimizer.step()
            return

        # Check for NaN/Inf gradients
        has_inf_or_nan = False
        for param_group in optimizer.param_groups:
            for param in param_group['params']:
                if param.grad is not None:
                    if torch.isnan(param.grad).any() or torch.isinf(param.grad).any():
                        has_inf_or_nan = True
                        break
            if has_inf_or_nan:
                break

        if has_inf_or_nan:
            # Skip step and reduce scale
            self._scale *= self.backoff_factor
            self._growth_tracker = 0
            # Zero gradients to clean up
            optimizer.zero_grad()
            return False  # Indicate step was skipped
        else:
            # Unscale gradients before stepping
            for param_group in optimizer.param_groups:
                for param in param_group['params']:
                    if param.grad is not None:
                        param.grad.div_(self._scale)

            optimizer.step()
            self._growth_tracker += 1
            return True  # Indicate step was successful

    def update(self):
        """Update the scale"""
        if not self._enabled:
            return

        if self._growth_tracker >= self.growth_interval:
            self._scale *= self.growth_factor
            self._growth_tracker = 0

    def state_dict(self):
        """Return state dict for checkpointing"""
        return {
            'scale': self._scale,
            'growth_factor': self.growth_factor,
            'backoff_factor': self.backoff_factor,
            'growth_interval': self.growth_interval,
            'growth_tracker': self._growth_tracker,
        }

    def load_state_dict(self, state_dict):
        """Load state dict from checkpoint"""
        self._scale = state_dict.get('scale', 65536.0)
        self.growth_factor = state_dict.get('growth_factor', 2.0)
        self.backoff_factor = state_dict.get('backoff_factor', 0.5)
        self.growth_interval = state_dict.get('growth_interval', 2000)
        self._growth_tracker = state_dict.get('growth_tracker', 0)
