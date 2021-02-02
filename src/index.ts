require("dotenv").config();
import * as admin from "firebase-admin";
import express from "express";
import axios from "axios";
import {
  GoogleCloudDialogflowV2WebhookRequest,
  GoogleCloudDialogflowV2WebhookResponse,
} from "./types";

admin.initializeApp();

const app = express();

app.use(express.json());

app.post("/webhook", async (req, res) => {
  const body: GoogleCloudDialogflowV2WebhookRequest = req.body;

  const intent = body.queryResult?.intent?.displayName;

  console.log(JSON.stringify(body, null, 2));

  if (intent) {
    const response = await intentMap[intent](body);

    return res.send(response);
  }
});

app.listen(process.env.PORT || 8080, () => {
  console.log("Server Running on port 8080");
});

const getNameBySenderId = (senderId: string, accessToken: string) => {
  const url = `https://graph.facebook.com/${senderId}?fields=name&access_token=${accessToken}`;
  return axios.get(url);
};

const getUserByName = async (name: string) => {
  try {
    const user = await admin
      .firestore()
      .collection("users")
      .where("facebookName", "==", name)
      .limit(1)
      .get();

    if (!user.empty) {
      return { ...user.docs[0].data(), id: user.docs[0].id } as {
        id: string;
        facebookName: string;
        ticketId: string;
        participation: { attend: boolean; groupId: string }[];
      };
    }
    return null;
  } catch (err) {
    throw err;
  }
};
const getGroupsByUser = async (user: {
  id: string;
  facebookName: string;
  ticketId: string;
  participation: { attend: boolean; groupId: string }[];
}) => {
  try {
    const groupIds = user.participation.map((val) => {
      return admin.firestore().collection("groups").doc(val.groupId);
    });
    const groups = await admin
      .firestore()
      .getAll(...groupIds)
      .then((snap) => {
        return snap.map((doc) => {
          return { id: doc.id, ...doc.data() } as {
            id: string;
            [key: string]: any;
          };
        });
      });
    return groups;
  } catch (err) {
    throw err;
  }
};

const getTicket = async (
  req: GoogleCloudDialogflowV2WebhookRequest
): Promise<GoogleCloudDialogflowV2WebhookResponse> => {
  const senderId = req.originalDetectIntentRequest?.payload?.data.sender.id;
  const ticketId = req.queryResult?.parameters?.number;
  const sender = await getNameBySenderId(
    senderId,
    `${process.env.ACCESS_TOKEN}`
  );
  const name = sender.data.name;
  const user = await getUserByName(name);

  if (!user) {
    return {
      fulfillmentMessages: [
        {
          text: {
            text: ["Sorry! It seems like you're not one of the participant."],
          },
        },
      ],
    };
  }

  const groups = await getGroupsByUser(user);

  if (ticketId == user.ticketId) {
    return {
      fulfillmentMessages: [
        {
          text: {
            text: [
              `Welcome ${name}, we would like to ask you a few questions.`,
            ],
          },
        },
        {
          quickReplies: {
            title: `Would you join ${groups[0]?.groupName}?`,
            quickReplies: ["Yes", "No"],
          },
        },
      ],
      outputContexts: [
        {
          name: `${req.session}/contexts/askingquestion`,
          lifespanCount: 10,
          parameters: { currentQuestion: 0, answers: [], user, groups },
        },
      ],
    };
  }

  return {
    fulfillmentMessages: [
      {
        text: {
          text: ["Sorry! It seems like you're not one of the participant."],
        },
      },
    ],
  };
};

const evalYesOrNo = async (
  req: GoogleCloudDialogflowV2WebhookRequest,
  answer: boolean
): Promise<GoogleCloudDialogflowV2WebhookResponse> => {
  const askingQuestion = req.queryResult?.outputContexts?.filter((context) => {
    return context.name == `${req.session}/contexts/askingquestion`;
  })[0];
  const currentQuestionIndex = askingQuestion?.parameters?.currentQuestion;
  const nextQuestionIndex = currentQuestionIndex + 1;
  const answers = askingQuestion?.parameters?.answers as Array<boolean>;
  answers[currentQuestionIndex] = answer;
  const nextQuestion = `Would you join ${askingQuestion?.parameters?.groups?.[nextQuestionIndex]?.groupName}?`;
  if (nextQuestionIndex >= askingQuestion?.parameters?.groups.length) {
    const participation = (askingQuestion?.parameters?.user?.participation as {
      groupId: string;
      attend: boolean;
    }[]).map((val, i) => {
      val.attend = answers[i];
      return val;
    });
    admin
      .firestore()
      .collection("users")
      .doc(askingQuestion?.parameters?.user.id)
      .update({ answers, participation })
      .then(() => {
        console.log("done");
      })
      .catch((err) => {
        console.log(err);
      });
    const msg = { text: { text: ["Here are all the details of event:"] } };
    const info = (askingQuestion?.parameters?.groups as Array<any>).reduce<
      Array<{ text: { text: string[] } }>
    >((total, val, index) => {
      const members = (val.members as {
        name: string;
        facebookLink: string;
      }[]).reduce<string>((total, val) => {
        total += `→${val.name} (${val.facebookLink})\n`;
        return total;
      }, "");
      if (answers[index]) {
        total.push({
          text: {
            text: [
              `\n\nGroup Name: ${val.groupName}\n${
                val.leader.name
                  ? `Leader: ${val.leader.name} (${val.leader.facebookLink})`
                  : ""
              }\nMembers: \n${members}`,
            ],
          },
        });
      }
      return total;
    }, []);
    return {
      fulfillmentMessages: [msg, ...info, { text: { text: ["Thank you"] } }],
      outputContexts: [
        {
          name: `${req.session}/contexts/askingquestion`,
          lifespanCount: 0,
        },
      ],
    };
  }
  return {
    fulfillmentMessages: [
      {
        quickReplies: {
          title: nextQuestion,
          quickReplies: ["Yes", "No"],
        },
      },
    ],
    outputContexts: [
      {
        name: `${req.session}/contexts/askingquestion`,
        lifespanCount: 10,
        parameters: {
          currentQuestion: nextQuestionIndex,
          answers,
        },
      },
    ],
  };
};

const yes = async (
  req: GoogleCloudDialogflowV2WebhookRequest
): Promise<GoogleCloudDialogflowV2WebhookResponse> => {
  return evalYesOrNo(req, true);
};

const no = async (
  req: GoogleCloudDialogflowV2WebhookRequest
): Promise<GoogleCloudDialogflowV2WebhookResponse> => {
  return evalYesOrNo(req, false);
};

const intentMap: { [key: string]: any } = {
  getTicket,
  yes,
  no,
};
