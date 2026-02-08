import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/context/AuthContext';

interface AuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  closeable?: boolean; // If false, dialog cannot be closed (required auth mode)
}

export function AuthDialog({ open, onOpenChange, closeable = true }: AuthDialogProps) {
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const { toast } = useToast();
  const { setJwtToken, getApiKey } = useAuth();

  return (
    <Dialog open={open} onOpenChange={closeable ? onOpenChange : undefined}>
      <DialogContent
        className="sm:max-w-[425px]"
        onPointerDownOutside={(e) => {
          if (!closeable) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (!closeable) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Authentication</DialogTitle>
          <DialogDescription>
            Login to your account or create a new one to access the chat.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'login' | 'register')} data-testid="auth-tabs">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login" data-testid="login-tab">Login</TabsTrigger>
            <TabsTrigger value="register" data-testid="register-tab">Register</TabsTrigger>
          </TabsList>

          <TabsContent value="login">
            <LoginForm
              onSuccess={(token) => {
                setJwtToken(token);
                toast({
                  title: 'Login Successful',
                  description: 'You are now logged in.',
                });
                onOpenChange(false);
              }}
              onError={(message) => {
                toast({
                  title: 'Login Failed',
                  description: message,
                  variant: 'destructive',
                });
              }}
              apiKey={getApiKey()}
            />
          </TabsContent>

          <TabsContent value="register">
            <RegisterForm
              onSuccess={(token) => {
                setJwtToken(token);
                toast({
                  title: 'Registration Successful',
                  description: 'Your account has been created.',
                });
                onOpenChange(false);
              }}
              onError={(message) => {
                toast({
                  title: 'Registration Failed',
                  description: message,
                  variant: 'destructive',
                });
              }}
              apiKey={getApiKey()}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

interface FormProps {
  onSuccess: (token: string) => void;
  onError: (message: string) => void;
  apiKey: string | null;
}

function LoginForm({ onSuccess, onError, apiKey }: FormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email.trim() || !password.trim()) {
      onError('Please fill in all fields.');
      return;
    }

    setIsLoading(true);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add API key if configured
      if (apiKey) {
        headers['X-API-KEY'] = apiKey;
      }

      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password }),
      });

      const responseData = await response.json();

      if (response.ok) {
        // Server sends { success: true, data: { token, entityId, username } }
        const { token, entityId } = responseData.data;

        // Store the authenticated entityId from server (replaces random frontend ID)
        if (entityId) {
          localStorage.setItem('elizaos-client-user-id', entityId);
        }

        onSuccess(token);
      } else {
        onError(responseData.error.message);
      }
    } catch (error) {
      onError('Unable to connect to the server. Please try again later.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 py-4" data-testid="login-form">
      <div className="space-y-2">
        <Label htmlFor="login-email">Email</Label>
        <Input
          id="login-email"
          data-testid="login-email-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="login-password">Password</Label>
        <div className="relative">
          <Input
            id="login-password"
            data-testid="login-password-input"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="pr-10"
            disabled={isLoading}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            disabled={isLoading}
            data-testid="login-password-toggle"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <DialogFooter>
        <Button type="submit" disabled={isLoading} data-testid="login-submit-button">
          {isLoading ? 'Logging in...' : 'Login'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RegisterForm({ onSuccess, onError, apiKey }: FormProps) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email.trim() || !username.trim() || !password.trim() || !confirmPassword.trim()) {
      onError('Please fill in all fields.');
      return;
    }

    if (password !== confirmPassword) {
      onError('Passwords do not match.');
      return;
    }

    if (password.length < 8) {
      onError('Password must be at least 8 characters long.');
      return;
    }

    setIsLoading(true);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add API key if configured
      if (apiKey) {
        headers['X-API-KEY'] = apiKey;
      }

      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, username, password }),
      });

      const responseData = await response.json();

      if (response.ok) {
        // Server sends { success: true, data: { token, entityId, username } }
        const { token, entityId } = responseData.data;

        // Store the authenticated entityId from server (replaces random frontend ID)
        if (entityId) {
          localStorage.setItem('elizaos-client-user-id', entityId);
        }

        onSuccess(token);
      } else {
        onError(responseData.error.message);
      }
    } catch (error) {
      onError('Unable to connect to the server. Please try again later.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 py-4" data-testid="register-form">
      <div className="space-y-2">
        <Label htmlFor="register-email">Email</Label>
        <Input
          id="register-email"
          data-testid="register-email-input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="register-username">Username</Label>
        <Input
          id="register-username"
          data-testid="register-username-input"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="register-password">Password</Label>
        <div className="relative">
          <Input
            id="register-password"
            data-testid="register-password-input"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="pr-10"
            disabled={isLoading}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            disabled={isLoading}
            data-testid="register-password-toggle"
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="register-confirm-password">Confirm Password</Label>
        <Input
          id="register-confirm-password"
          data-testid="register-confirm-password-input"
          type={showPassword ? 'text' : 'password'}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="••••••••"
          disabled={isLoading}
        />
      </div>

      <DialogFooter>
        <Button type="submit" disabled={isLoading} data-testid="register-submit-button">
          {isLoading ? 'Creating account...' : 'Register'}
        </Button>
      </DialogFooter>
    </form>
  );
}
