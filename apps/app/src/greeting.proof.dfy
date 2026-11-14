// Strings are sequences, and two of different lengths differ: the invitation is longer than "Hello, !", and a
// greeting is longer by the name, which inv says is not empty.
lemma greeting_ensures(g: Greeter)
  requires inv(g)
  ensures (greeting(g) != "Hello, !")
{
  assert |"Hello, !"| == 8;
  if g.count > 0 {
    assert |greeting(g)| == 8 + |g.name|;
  } else {
    assert |greeting(g)| == 19;
  }
}
