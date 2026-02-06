import styled from "styled-components";

export const StyledGameList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0 5%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-gap: 20px;
  grid-auto-rows: minmax(100px, auto);

  @media screen and (max-width: 1024px) {
    grid-template-columns: repeat(2, 1fr);
  }

  @media screen and (max-width: 640px) {
    grid-template-columns: repeat(1, 1fr);
  }
`;
