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

  if (intent) {
    const response = await intentMap[intent](body);

    return res.send(response);
  }
});

app.listen(process.env.PORT || 8080, () => {
  console.log("Server Running on port 8080");
});

const questionsToAsk = [
  "Will you join the first day of event ?",
  "What about the second day ?",
];

const getNameBySenderId = (senderId: string, accessToken: string) => {
  const url = `https://graph.facebook.com/${senderId}?fields=name&access_token=${accessToken}`;
  return axios.get(url);
};

const getUserByName = async (name: string) => {
  try {
    const user = await admin
      .firestore()
      .collection("users")
      .where("name", "==", name)
      .limit(1)
      .get();

    if (!user.empty) {
      return { ...user.docs[0].data(), id: user.docs[0].id } as {
        id: string;
        name: string;
        ticketId: string;
      };
    }
    return null;
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
          text: {
            text: [questionsToAsk[0]],
          },
        },
      ],
      outputContexts: [
        {
          name: `${req.session}/contexts/askingquestion`,
          lifespanCount: 10,
          parameters: { currentQuestion: 0, answers: [], userId: user.id },
        },
      ],
    };
  }

  return {
    fulfillmentMessages: [
      {
        text: {
          text: ["It seems like there is some error."],
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
  const nextQuestion = questionsToAsk[nextQuestionIndex];
  const answers = askingQuestion?.parameters?.answers as Array<boolean>;
  answers[currentQuestionIndex] = answer;
  if (nextQuestionIndex >= questionsToAsk.length) {
    admin
      .firestore()
      .collection("users")
      .doc(askingQuestion?.parameters?.userId)
      .update({ answers })
      .then(() => {
        console.log("done");
      })
      .catch((err) => {
        console.log(err);
      });
    return {
      fulfillmentMessages: [{ text: { text: ["Thank you"] } }],
    };
  }
  return {
    fulfillmentMessages: [{ text: { text: [nextQuestion] } }],
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
