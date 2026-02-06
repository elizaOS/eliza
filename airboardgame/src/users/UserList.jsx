import React from "react";
import { useUsers } from "react-sync-board";
import styled from "styled-components";

import UserConfig from "./UserConfig";

const InlineUserList = styled.ul.attrs(() => ({ className: "uk-card" }))`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
`;

const InlineUserListItem = styled.li`
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
`;

export const Users = () => {
  const { currentUser, updateCurrentUser, localUsers: users } = useUsers();

  return (
    <InlineUserList>
      {users.map((u, index) => (
        <InlineUserListItem key={u.id}>
          <UserConfig
            index={index + 1}
            user={u}
            updateCurrentUser={updateCurrentUser}
            editable={currentUser.id === u.id}
          />
        </InlineUserListItem>
      ))}
    </InlineUserList>
  );
};

export default Users;
