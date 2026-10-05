package ai.eliza.speech;

import java.util.*;
/** Stateless text validation shared by native synthesis and acceptance fixtures. */
public final class SpeechText {
 private SpeechText() {}
 public static String prepare(String text, Set<String> words) {
  if(text==null||text.trim().isEmpty()||text.length()>500||text.indexOf('\0')>=0)throw new IllegalArgumentException("Expected 1 to 500 text characters");
  StringBuilder spoken=new StringBuilder();java.util.regex.Matcher tokens=java.util.regex.Pattern.compile("[A-Za-z]+(?:'[A-Za-z]+)?|[0-9]|[.,!?;:]|[^\\s]").matcher(text);
  String[] digits={"zero","one","two","three","four","five","six","seven","eight","nine"};
  while(tokens.find()){String token=tokens.group().toLowerCase(Locale.ROOT);if(token.length()==1&&Character.isDigit(token.charAt(0)))token=digits[token.charAt(0)-'0'];
   if(words.contains(token)||token.matches("[.,!?;:]"))spoken.append(token).append(' ');
   else if(token.matches("[a-z']+")){for(char letter:token.toCharArray())if(letter!='\''){String letterName=letter=='a'?"ay":String.valueOf(letter);if(!words.contains(letterName))throw new IllegalStateException("Missing letter pronunciation");spoken.append(letterName).append(' ');}}
   else if(token.equals("(")||token.equals(")"))spoken.append(' ');
   else throw new IllegalArgumentException("Local speech currently supports English text; unsupported symbol");
  }
  if(spoken.length()==0||spoken.length()>2000)throw new IllegalArgumentException("Text exceeds local speech limit");
  return spoken.toString();
 }
}
