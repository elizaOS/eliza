// spec/os/agentService/config.md, "The character, policy and launch settings are admitted exactly as the agent admits them"
package ai.eliza.os.agent;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.regex.Pattern;

public final class PatternFlags {
  private PatternFlags() {}

  public static void main(String[] args) throws Exception {
    for (Field field : AgentConfig.class.getDeclaredFields()) {
      if (!Modifier.isStatic(field.getModifiers()) || field.getType() != Pattern.class) continue;
      field.setAccessible(true);
      Pattern pattern = (Pattern) field.get(null);
      System.out.println("{\"field\":\"" + field.getName() + "\",\"flags\":" + pattern.flags() + "}");
    }
  }
}
