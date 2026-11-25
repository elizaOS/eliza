// spec/os/agentService/config.md, "The character, policy and launch settings are admitted exactly as the agent admits them"
package ai.eliza.os.agent;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

public final class PatternFlags {
  private PatternFlags() {}

  public static void main(String[] args) throws Exception {
    for (Field field : AgentConfig.class.getDeclaredFields()) {
      if (!Modifier.isStatic(field.getModifiers()) || field.getType() != Pattern.class) continue;
      field.setAccessible(true);
      Pattern pattern = (Pattern) field.get(null);
      Map<String, Object> answer = new LinkedHashMap<>();
      answer.put("field", field.getName());
      answer.put("flags", pattern.flags());
      answer.put("source", pattern.pattern());
      System.out.println(AgentConfig.json(answer));
    }
  }
}
